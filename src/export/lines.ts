import { currencyDigits } from "./format.js";

/*
 * The lines of the export (SPEC.md §20) and their values in a currency, as the merchant's app makes
 * them from its rows (src/features/wallet/export/rows.ts of the app): what a line is (a sale paid,
 * a transfer received or sent), its sats signed, its fees, and its value: the sale's own amount,
 * else its sats at the price of bitcoin recorded at its payment, rounded to the nearest minor
 * unit. Amounts are integers to the end; a rate is a price, never an amount.
 */

/** A payment of a line, as the merchant's wallet lists it (what the export reads of it). */
export type LinePayment = {
  /** The wallet's id of the payment, or the line's own for a payment the wallet does not name. */
  id: string;
  direction: "receive" | "send";
  status: "completed" | "pending" | "failed";
  /** Sats, a decimal string. */
  amountSats: string;
  /** Sats, a decimal string. */
  feeSats: string;
  /** Unix seconds. */
  timestamp: number;
  network: "lightning" | "bitcoin" | "spark" | "unknown";
  paymentHash: string | null;
  txId: string | null;
  lightningAddress: string | null;
  description: string | null;
};

export type LineFiat = { minor: number; digits: number; currency: string };

/** A line of the export: what the app's row holds that the export reads (vectors/app/export.json). */
export type Line = {
  /** Stable: orders two lines of one second. */
  id: string;
  source: "pos" | "link" | "integration" | "receive" | "send";
  /** Unix seconds: when it was paid. */
  at: number;
  note: string;
  invoice: { number: string; recipient: string } | null;
  /** « Par »: « Vous », a seat's name, or nobody. */
  by: { kind: "you" } | { kind: "seat"; name: string } | null;
  /** The newest first. */
  payments: LinePayment[];
  /** What moved, in sats (received, or sent without fees), unsigned: a decimal string. */
  sats: string;
  /** The sale's own amount; null for a transfer. */
  fiat: LineFiat | null;
  /** The price of bitcoin recorded at its payment; null when none. */
  rate: { currency: string; rate: number } | null;
  /** A row of the history copied from the v2 account (no payment of the wallet). */
  imported: boolean;
  /** The owner's acceptance of a sale paid short. */
  acceptance: { received: string; due: string; at: number; fiat: LineFiat | null } | null;
};

export type RowKind = "paid" | "received" | "sent";

/** A line as the files write it: its kind, its sats signed (sent negative), its fees. */
export type Row = { line: Line; kind: RowKind; sats: bigint; feeSats: bigint | null };

const KINDS = {
  pos: "paid",
  link: "paid",
  integration: "paid",
  receive: "received",
  send: "sent"
} as const;

/**
 * The rows of `lines` within `range` (both bounds included), the oldest first, then by id (UTF-16
 * order): a line without a payment of the wallet only when it is of the v2 history.
 */
export function exportRows(lines: readonly Line[], range: { start: number; end: number }): Row[] {
  const rows: Row[] = [];
  for (const line of lines) {
    if (line.at < range.start || line.at > range.end) continue;
    if (line.payments.length === 0 && !line.imported) continue;
    const kind = KINDS[line.source];
    const sats = BigInt(line.sats);
    rows.push({
      line,
      kind,
      sats: kind === "sent" ? -sats : sats,
      // A v2 history row tells no fee: none, never « 0 ».
      feeSats:
        kind === "sent" && !line.imported
          ? line.payments.reduce(
              (total, payment) =>
                payment.status === "completed" ? total + BigInt(payment.feeSats) : total,
              0n
            )
          : null
    });
  }
  return rows.sort(
    (a, b) => a.line.at - b.line.at || (a.line.id < b.line.id ? -1 : a.line.id > b.line.id ? 1 : 0)
  );
}

/** A row's value in a currency: its sale's own amount, or its sats at its rate. */
export type RowValue = {
  minor: bigint;
  currency: string;
  digits: number;
  /** A sending's fees at the same rate; null for anything else. */
  feeMinor: bigint | null;
  /** The sale's own amount (not a conversion). */
  own: boolean;
  /** The rate recorded at its payment; null when none. */
  rate: { currency: string; rate: number } | null;
};

/** A positive price as an exact fraction of its shortest decimal (JavaScript's Number::toString). */
export function rateToFraction(rate: number): { numerator: bigint; denominator: bigint } {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("Invalid rate");
  const text = rate.toString().includes("e") ? rate.toFixed(20) : rate.toString();
  const [whole, fraction = ""] = text.split(".");
  const numerator = BigInt(whole! + fraction);
  if (numerator <= 0n) throw new Error("Invalid rate");
  return { numerator, denominator: 10n ** BigInt(fraction.length) };
}

/** Sats at `rate` in minor units of `digits` decimals, rounded half up, on integers. */
export function satsToMinor(sats: bigint, digits: number, rate: number): bigint {
  if (sats < 0n) throw new Error("Invalid sats");
  const { numerator, denominator } = rateToFraction(rate);
  const divisor = 100_000_000n * denominator;
  return (sats * numerator * 10n ** BigInt(digits) + divisor / 2n) / divisor;
}

/** A row's value (the app's rowValue): its own amount, else its sats at its rate; null without. */
export function rowValue(row: Row): RowValue | null {
  const { line } = row;
  const rate = line.rate;
  if (line.fiat !== null) {
    return {
      minor: BigInt(line.fiat.minor),
      currency: line.fiat.currency,
      digits: line.fiat.digits,
      feeMinor: null,
      own: true,
      rate
    };
  }
  if (rate === null) return null;
  const digits = currencyDigits(rate.currency);
  const abs = row.sats < 0n ? -row.sats : row.sats;
  const minor = satsToMinor(abs, digits, rate.rate);
  return {
    minor: row.sats < 0n ? -minor : minor,
    currency: rate.currency,
    digits,
    feeMinor: row.feeSats === null ? null : satsToMinor(row.feeSats, digits, rate.rate),
    own: false,
    rate
  };
}

/**
 * The values of `rows`, as the app reads them: none at all when no row has a completed payment of
 * the wallet (the app then reads no rate).
 */
export function rowValues(rows: readonly Row[]): (RowValue | null)[] {
  const completed = rows.some((row) =>
    row.line.payments.some(({ status }) => status === "completed")
  );
  return rows.map((row) => (completed ? rowValue(row) : null));
}
