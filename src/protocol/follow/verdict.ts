import { HOUR_SECONDS } from "../constants.js";
import { pointHour, satsAt } from "../points.js";

/*
 * The status of a sale from its proven payments (SPEC.md §15, "The status"): the rule the merchant's
 * app settles a payment link with (src/features/terminal/useSale.ts), taken as one look at what was
 * read. Pure: amounts in sats (bigint), times in Unix seconds, points as CoinGecko gives them.
 */

/** A Lightning payment counted: paid with its preimage, unique to the sale. */
export type LightningPayment = {
  hour: number;
  /** Unix seconds: when its invoice was made (its BOLT11 timestamp). */
  timestamp: number;
  sats: bigint;
  paymentHash: string;
  preimage: string;
};

/** A transaction paying the sale's address: what it pays, its depth, when it counts from (ms). */
export type OnchainPayment = { txid: string; sats: bigint; confirmations: number; at: number };

export type SaleProofs = {
  /** Unix seconds. */
  now: number;
  endsAt: number;
  fiat: { minor: number; digits: number };
  /** The sale's tolerance of on-chain underpayments, basis points (its link's record). */
  tolerance: number;
  lightning: readonly LightningPayment[];
  /** Ends (Unix seconds) of the declared invoices that may still be told paid. */
  openInvoiceEnds: readonly number[];
  /** The transactions paying the address; empty without one or when none. */
  onchain: readonly OnchainPayment[];
  /** The points read, by hour. */
  points: ReadonlyMap<number, number>;
  /** The merchant's acceptance of the sale paid short: what it had received then. */
  acceptance: { received: bigint } | null;
};

export type Verdict =
  | {
      state: "paid";
      method: "lightning" | "onchain" | "mixed";
      received: bigint;
      /** What was due at the hour that settled it; null when the merchant accepted less. */
      due: bigint | null;
      /** The merchant's tolerance or acceptance took less than due. */
      accepted: boolean;
    }
  | { state: "confirming"; method: "onchain" | "mixed"; received: bigint; confirmations: number }
  | {
      state: "underpaid";
      received: bigint;
      /** Before the end: what the present hour's point still asks (null while not published). */
      rest: bigint | null;
      /** After the end: what it fell short of, for good. */
      due: bigint | null;
      ended: boolean;
    }
  | { state: "open" }
  | { state: "expired" }
  | { state: "checking"; reason: CheckingReason };

export type CheckingReason =
  /** A price of an hour that decides it is not read yet. */
  | "price"
  /** A Lightning invoice of the sale may still be told paid. */
  | "late_report"
  | "relays"
  | "lightning_address"
  | "payment_check"
  | "uniqueness"
  | "former_name"
  | "explorer"
  | "replacements"
  | "time"
  | "late_payment"
  | "link";

const CONFIRMATIONS = 3;
const SCALE = 10_000n;

/** The least `due` accepted with `tolerance` (basis points, 0 to 1000). */
export function leastAccepted(due: bigint, tolerance: number): bigint {
  const valid = Number.isInteger(tolerance) && tolerance >= 0 && tolerance <= 1000;
  return due - (due * BigInt(valid ? tolerance : 0)) / SCALE;
}

/** Whether `received` pays `due`, `onchain` of it on-chain, with `tolerance`. */
export function coversWith(
  received: bigint,
  onchain: bigint,
  due: bigint,
  tolerance: number
): boolean {
  if (received >= due) return true;
  return onchain > 0n && received >= leastAccepted(due, tolerance);
}

/** What the address must bring of `due` once Lightning paid `paidOtherwise`. */
export function dueOnchain(due: bigint, tolerance: number, paidOtherwise: bigint): bigint {
  if (paidOtherwise >= due) return 0n;
  const left = leastAccepted(due, tolerance) - paidOtherwise;
  return left > 0n ? left : 1n;
}

export function verdictOf(proofs: SaleProofs): Verdict {
  const { now, endsAt, fiat, tolerance, points } = proofs;
  const hour = pointHour(now);
  const ended = now >= endsAt;
  const dueAt = (time: number): bigint | null => {
    const point = points.get(time);
    return point === undefined ? null : satsAt(fiat.minor, fiat.digits, point);
  };
  const lightningSats = proofs.lightning.reduce((sum, paid) => sum + paid.sats, 0n);
  const onchainSats = proofs.onchain.reduce((sum, tx) => sum + tx.sats, 0n);
  const received = lightningSats + onchainSats;
  const txHour =
    proofs.onchain.length > 0
      ? pointHour(Math.floor(Math.max(...proofs.onchain.map((tx) => tx.at)) / 1000))
      : null;
  const paymentHours = [
    ...proofs.lightning.map((paid) => paid.hour),
    ...(onchainSats > 0n && txHour !== null ? [txHour] : [])
  ];
  const invoicesOpen = proofs.openInvoiceEnds.length > 0;

  if (paymentHours.length === 0) {
    if (!ended) return { state: "open" };
    return invoicesOpen ? { state: "checking", reason: "late_report" } : { state: "expired" };
  }

  // The span: from the last payment's hour to the present, never past the sale's last hour.
  const lastPaymentHour = Math.max(...paymentHours);
  const lastHour = Math.max(lastPaymentHour, Math.min(hour, pointHour(endsAt - 1)));
  let bestDue: bigint | null = null;
  let pastUnknown = false;
  for (let time = lastPaymentHour; time <= lastHour; time += HOUR_SECONDS) {
    const due = dueAt(time);
    if (due !== null && (bestDue === null || due < bestDue)) bestDue = due;
    else if (due === null && (time < hour || time === lastPaymentHour)) pastUnknown = true;
  }
  const duePending =
    pastUnknown && !(bestDue !== null && coversWith(received, onchainSats, bestDue, tolerance));

  // 1. Lightning pays it: at the lowest point known, so at the lowest of all (an hour not read can
  // only lower what is due).
  if (bestDue !== null && lightningSats >= bestDue) {
    return {
      state: "paid",
      method: onchainSats > 0n ? "mixed" : "lightning",
      received,
      due: bestDue,
      accepted: false
    };
  }
  if (duePending || bestDue === null) return { state: "checking", reason: "price" };

  const underpaid = (): Verdict => {
    if (proofs.acceptance && received >= proofs.acceptance.received) {
      const method = onchainSats > 0n ? (lightningSats > 0n ? "mixed" : "onchain") : "lightning";
      return { state: "paid", method, received, due: null, accepted: true };
    }
    if (!ended) {
      const now = dueAt(hour);
      return {
        state: "underpaid",
        received,
        rest: now === null ? null : now > received ? now - received : 0n,
        due: null,
        ended: false
      };
    }
    if (invoicesOpen) return { state: "checking", reason: "late_report" };
    return { state: "underpaid", received, rest: null, due: bestDue, ended: true };
  };

  // 2. On-chain: enough at the least the tolerance accepts, then deep enough.
  if (onchainSats > 0n) {
    const expected = dueOnchain(bestDue, tolerance, lightningSats);
    if (onchainSats < expected) return underpaid();
    const method = lightningSats > 0n ? "mixed" : "onchain";
    const confirmations = Math.min(...proofs.onchain.map((tx) => tx.confirmations));
    if (confirmations < CONFIRMATIONS) {
      return { state: "confirming", method, received, confirmations };
    }
    return { state: "paid", method, received, due: bestDue, accepted: received < bestDue };
  }
  // 3. Lightning paid less than due.
  return underpaid();
}
