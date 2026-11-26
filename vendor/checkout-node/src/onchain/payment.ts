import { NetworkError } from "../errors.js";
import type { HttpOptions } from "../http.js";
import { CONFIRMATIONS, GRACE_SECONDS, MAX_WITNESS_INPUTS } from "../protocol.js";
import type { Logger, PaymentStatus } from "../types.js";

import {
  addressTransactions,
  chainHeight,
  confirmationsOf,
  paysTo,
  receivedAt,
  type Explorer,
  type ExplorerTx
} from "./explorer.js";
import type { MerchantAcceptance } from "./merchant-acceptance.js";
import { paymentParts, type PaymentTx } from "./replacements.js";
import { byRestOrder, restOf, type RestInvoice } from "./rest.js";
import { dueOnchain } from "./tolerance.js";
import type { OrderWitnesses, Witness } from "./witness.js";

/*
 * The payment of an invoice (SPEC.md, "The on-chain payment"): its on-chain part, from the
 * explorer (mempool.space or the merchant's Bitcoin node) and the witnesses of its order, its rest part (the Lightning invoices of the rest of an
 * underpayment, "The rest of an underpayment"), and how they combine with its Lightning part.
 */

/** The Lightning part of an invoice (SPEC.md, "Payment check"), from its verify URL. */
export type LightningPart =
  { state: "open" } | { state: "expired" } | { state: "paid"; preimage: string };

/** The on-chain part of an invoice with an address. */
export type OnchainPart =
  /** Less than the amount came in time: final once the lease ended and nothing is undecided. */
  | { kind: "underpaid"; received: bigint; final: boolean }
  | { kind: "unconfirmed"; received: bigint; confirmations: number; txids: string[] }
  /** 3 confirmations on the explorer read. */
  | { kind: "paid"; received: bigint; txids: string[] };

/** What the on-chain part of an invoice needs. */
export type OnchainCheck = {
  /** The invoice's deposit address, its amount and its end. */
  address: string;
  sats: bigint;
  expiresAt: number;
  /** The order's sale: its author (hex). */
  sale: string;
  /**
   * The server's clock (Unix seconds), read once the explorer answered: a transaction it lists was
   * broadcast by then (SPEC.md, "The on-chain payment").
   */
  clock: () => number;
  /**
   * The explorer (explorer.ts): the address's transactions and the chain's height are one read of
   * it, both of one explorer.
   */
  explorer: Explorer;
  /** For the explorer and BlockCypher. */
  http: HttpOptions;
  /**
   * The witnesses of the order (NetworkError when fewer than a majority answered); with
   * everyRelay, read on every relay, each until its timeout.
   */
  readWitnesses: (options?: { everyRelay?: boolean }) => Promise<OrderWitnesses>;
  /** The witness address of `txid` paying the address for the sale, or for none (null). */
  witnessAddress: (txid: string, sale: string | null) => string;
  /** Publishes a witness on a majority of the merchant's relays, else NetworkError. */
  publish: (witness: Witness) => Promise<void>;
  logger: Logger;
  /**
   * What the invoice's rest invoices paid (its rest part, checked at the same time; one that
   * failed counts as not paid): the on-chain part needs only the difference. 0 without.
   */
  paidByRests?: Promise<bigint>;
  /**
   * The order's tolerance of on-chain underpayments (its lease's, basis points: tolerance.ts),
   * read with the sale's records at the same time; 0 without (none, or the records unread).
   */
  tolerance?: Promise<number>;
  /**
   * The merchant's acceptance of the invoice (merchant-acceptance.ts), read on every relay at the
   * same time as the witnesses, when some transaction pays the address (NetworkError when fewer
   * than a majority answered). None without.
   */
  readMerchantAcceptance?: () => Promise<MerchantAcceptance>;
};

type Kind = "in time" | "replacement" | "late" | "undecided" | "another's";

/**
 * The on-chain part of an invoice, checked at `now` (the clock once the explorer answered): each
 * transaction paying its address in time
 * (while the lease ran, as a witness of the sale or BlockCypher's time says), a replacement of
 * payments in time, late, or undecided; what counts of them; and, once enough counts, their
 * confirmations on the explorer read: paid at 3. Publishes the witnesses it finds (of the sale on a majority,
 * else NetworkError; of none for the merchant's app only, a failure logged). What is due on-chain
 * is the least the order's tolerance accepts of the amount (the amount without tolerance), or the
 * `received` of the merchant's acceptance a majority of the relays sent when less, less what its
 * rest invoices paid, a sat at least (dueOnchain): when they pay the amount, the on-chain part is
 * `paid` without transactions (combineParts tells it paid by its rests). Throws NetworkError when
 * the explorer (with its fallback), BlockCypher or the relays fail.
 */
export async function checkOnchainPart(check: OnchainCheck): Promise<OnchainPart> {
  const { address, sats, http, sale } = check;
  const end = check.expiresAt + GRACE_SECONDS;
  // One read, of one explorer: a transaction's confirmations compare its block's height with
  // that explorer's height. Either failing, both are asked of the next explorer (SPEC.md §31).
  const [txs, height] = await check.explorer.read(http, (base, asked) =>
    Promise.all([addressTransactions(base, address, asked), chainHeight(base, asked)])
  );
  // After the explorer's answer, never before: "listed now, it was broadcast by now".
  const now = check.clock();
  const paying: { tx: ExplorerTx; pays: bigint }[] = [];
  for (const tx of txs) {
    const pays = paysTo(tx, address);
    if (pays > 0n && !paying.some((other) => other.tx.txid === tx.txid)) paying.push({ tx, pays });
  }
  // The witnesses, and the merchant's acceptance with them (on every relay), when some transaction
  // pays the address.
  const noAcceptance: MerchantAcceptance = { received: null, newer: false };
  const [witnesses, accepted]: [OrderWitnesses, MerchantAcceptance] =
    paying.length > 0
      ? await Promise.all([
          check.readWitnesses(),
          check.readMerchantAcceptance?.() ?? Promise.resolve(noAcceptance)
        ])
      : [{ sale: new Map(), others: new Map(), none: new Set(), newer: new Set() }, noAcceptance];
  const listed = new Set(paying.map(({ tx }) => tx.txid));
  if (witnesses.newer.size > 0) {
    check.logger.warn(
      "@sattleme/checkout: a witness of this address has a newer format than this version of " +
        "@sattleme/checkout: update it"
    );
  }
  if (accepted.newer) {
    check.logger.warn(
      "@sattleme/checkout: a merchant's acceptance of this order has a newer format than this " +
        "version of @sattleme/checkout: update it"
    );
  }

  // The parts: from the witnesses of this invoice and of other invoices (in the order they were
  // seen), then the transactions no such witness names (their order unknown): a replacement of
  // another invoice's payment stands for it.
  const partsOf = (read: OrderWitnesses) =>
    paymentParts([
      ...[...read.sale, ...read.others].map(([txid, witness]): PaymentTx => ({
        txid,
        sats: witness.sats,
        inputs: witness.inputs,
        order: witness.seenAt,
        listed: listed.has(txid)
      })),
      ...paying
        .filter(({ tx }) => !read.sale.has(tx.txid) && !read.others.has(tx.txid))
        .map(({ tx, pays }): PaymentTx => ({
          txid: tx.txid,
          sats: pays,
          inputs: tx.coins,
          order: null,
          listed: true
        }))
    ]);
  /** Another invoice's: a witness of another invoice names it, or the root of one of its parts. */
  const anothers = (read: OrderWitnesses, partsRead: ReturnType<typeof partsOf>, txid: string) =>
    read.others.has(txid) || partsRead.get(txid)!.some(({ root }) => read.others.has(root));
  const parts = partsOf(witnesses);

  const newerNames = (txid: string, sale: string | null) =>
    witnesses.newer.has(check.witnessAddress(txid, sale));
  // A witness of a newer format that names no transaction listed may be of a payment replaced.
  const newerElsewhere = [...witnesses.newer].some(
    (d) =>
      !paying.some(
        ({ tx }) =>
          d === check.witnessAddress(tx.txid, sale) || d === check.witnessAddress(tx.txid, null)
      )
  );

  const kinds = new Map<string, Kind>();
  /** Witnesses of the sale to publish (on a majority), and of none (logged when they fail). */
  const ofSale: Witness[] = [];
  const ofNone: Witness[] = [];
  const witnessOf = (tx: ExplorerTx, pays: bigint, forSale: boolean, replacement: boolean) => ({
    address,
    txid: tx.txid,
    sale: forSale ? sale : null,
    sats: pays,
    inputs: tx.coins.slice(0, MAX_WITNESS_INPUTS),
    replacement,
    expiresAt: forSale ? check.expiresAt : null
  });
  for (const { tx, pays } of paying) {
    const { txid } = tx;
    // Another invoice's: a transaction counts for one invoice at most.
    if (anothers(witnesses, parts, txid)) {
      kinds.set(txid, "another's");
      continue;
    }
    const witness = witnesses.sale.get(txid);
    if (witness && !witness.replacement) {
      kinds.set(txid, "in time");
      continue;
    }
    if (newerNames(txid, sale)) {
      kinds.set(txid, "undecided");
      continue;
    }
    if (now <= end) {
      // Listed now, it was broadcast by now: while the lease runs.
      kinds.set(txid, "in time");
      ofSale.push(witnessOf(tx, pays, true, false));
      continue;
    }
    if (witness) {
      // An earlier check found it a replacement, and BlockCypher's time of it late.
      kinds.set(txid, "replacement");
      continue;
    }
    // No check saw it in time.
    const own = parts.get(txid)!;
    const replaces = own.some(({ root }) => root !== txid);
    if (own.some(({ root }) => root === txid)) {
      const time = await receivedAt(txid, http);
      if (time !== null && time <= end * 1000) {
        kinds.set(txid, "in time");
        ofSale.push(witnessOf(tx, pays, true, false));
        continue;
      }
    }
    if (newerElsewhere) {
      kinds.set(txid, "undecided");
    } else if (replaces) {
      kinds.set(txid, "replacement");
      ofSale.push(witnessOf(tx, pays, true, true));
    } else {
      // Its payment reaches the merchant's wallet, but no order. A witness `none` names it, or one
      // of a newer format at that witness's address: never written over (SPEC.md §12).
      kinds.set(txid, "late");
      if (!witnesses.none.has(txid) && !newerNames(txid, null)) {
        ofNone.push(witnessOf(tx, pays, false, false));
      }
    }
  }
  await Promise.all([
    ...ofSale.map((witness) => check.publish(witness)),
    ...ofNone.map((witness) =>
      check.publish(witness).catch((error: unknown) => {
        if (!(error instanceof NetworkError)) throw error;
        check.logger.warn(
          `@sattleme/checkout: the witness of a late payment was not published: ${error.message}`
        );
      })
    )
  ]);
  // Its witnesses on a majority, read again on every relay: of two checks that publish witnesses
  // of one transaction at once, the later reader sees both, whatever one relay hides.
  if (ofSale.length > 0) {
    const again = await check.readWitnesses({ everyRelay: true });
    const partsAgain = partsOf(again);
    for (const { tx } of paying) {
      if (anothers(again, partsAgain, tx.txid)) kinds.set(tx.txid, "another's");
    }
  }

  const inTime = (root: string) =>
    listed.has(root)
      ? kinds.get(root) === "in time"
      : witnesses.sale.get(root)?.replacement === false;
  const counted = new Map<string, bigint>();
  for (const { tx } of paying) {
    const kind = kinds.get(tx.txid);
    if (kind === "undecided" || kind === "another's") continue;
    const sum = parts
      .get(tx.txid)!
      .filter(({ root }) => inTime(root))
      .reduce((total, part) => total + part.sats, 0n);
    if (sum > 0n) counted.set(tx.txid, sum);
  }
  const received = [...counted.values()].reduce((total, sum) => total + sum, 0n);
  const [paidByRests, tolerance] = await Promise.all([
    check.paidByRests ?? Promise.resolve(0n),
    check.tolerance ?? Promise.resolve(0)
  ]);
  // Nothing due when the rest invoices paid it all; else the least the order's tolerance accepts,
  // or what the merchant accepted when less, less what they paid, at least a sat.
  const due = dueOnchain(sats, tolerance, paidByRests, accepted.received);
  if (due === 0n) return { kind: "paid", received, txids: [] };
  if (received < due) {
    const undecided = [...kinds.values()].includes("undecided");
    return { kind: "underpaid", received, final: now > end && !undecided };
  }
  const order = paying.filter(({ tx }) => counted.has(tx.txid)).map(({ tx }) => tx);
  const txids = order.map(({ txid }) => txid);
  const confirmations = Math.min(...order.map((tx) => confirmationsOf(tx, height)));
  if (confirmations >= CONFIRMATIONS) return { kind: "paid", received, txids };
  return { kind: "unconfirmed", received, confirmations, txids };
}

/** A part's outcome: its result, or the error it failed with. */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** The rest part of an invoice: its rest invoices, and the Lightning part of each, in order. */
export type RestPart = {
  invoices: readonly RestInvoice[];
  results: readonly Settled<LightningPart>[];
  /** The sale's records could not be read: whether a rest invoice was paid cannot be told. */
  error?: unknown;
  /**
   * The payment hashes of the rest invoices whose rest record is not known on a majority of the
   * relays: never the status's `bolt11` (a checkout link's page might never see their payment).
   * Absent: none.
   */
  unrecorded?: ReadonlySet<string>;
};

/** What an invoice is, for its status: its amount, its end and its address (null without one). */
export type InvoiceTerms = { sats: bigint; expiresAt: number; address: string | null };

/**
 * What the rest invoices of `rests` paid (each payment hash once; one that failed counts as not
 * paid), their preimages in order, whether each is final, and the first error.
 */
export function restSummary(rests: RestPart | null): {
  paid: bigint;
  preimages: string[];
  hashes: Set<string>;
  final: boolean;
  error: { error: unknown } | null;
} {
  const summary = {
    paid: 0n,
    preimages: [] as string[],
    hashes: new Set<string>(),
    final: true,
    error: null as { error: unknown } | null
  };
  if (rests && "error" in rests) {
    summary.final = false;
    summary.error = { error: rests.error };
  }
  // In the order of the rest invoices (by date, then payment hash), whatever the order given.
  const order = (rests?.invoices ?? [])
    .map((invoice, index) => ({ invoice, result: rests!.results[index]! }))
    .sort((a, b) => byRestOrder(a.invoice, b.invoice));
  for (const { invoice, result } of order) {
    if (!result.ok) {
      summary.final = false;
      summary.error ??= { error: result.error };
      continue;
    }
    if (result.value.state === "paid") {
      if (summary.hashes.has(invoice.paymentHash)) continue;
      summary.hashes.add(invoice.paymentHash);
      summary.paid += invoice.sats;
      summary.preimages.push(result.value.preimage);
    } else if (result.value.state === "open") {
      summary.final = false;
    }
  }
  return summary;
}

/**
 * The status of an invoice from its parts (SPEC.md, "The on-chain payment"): paid in Lightning,
 * else paid by its rest invoices alone, else paid on-chain (mixed when rest invoices paid part of
 * it), else unconfirmed on-chain, else an error of a part (the Lightning part's first, then the
 * rest part's, then the on-chain part's, thrown), else expired once every part is final, else
 * open, with its rest. A part is null when the invoice has none (no Lightning invoice, no
 * address). `received` counts what the rest invoices paid. `now`: Unix seconds.
 */
export function combineParts(
  invoice: InvoiceTerms,
  now: number,
  lightning: Settled<LightningPart> | null,
  onchain: Settled<OnchainPart> | null,
  rests: RestPart | null = null
): PaymentStatus {
  if (lightning?.ok && lightning.value.state === "paid") {
    return { state: "paid", method: "lightning", preimage: lightning.value.preimage };
  }
  const summary = restSummary(rests);
  if (summary.paid >= invoice.sats) {
    // What came on-chain in time counts too (0 when the on-chain part failed).
    const onchainReceived = onchain?.ok ? onchain.value.received : 0n;
    return {
      state: "paid",
      method: "mixed",
      received: (onchainReceived + summary.paid).toString(),
      txids: [],
      preimages: summary.preimages
    };
  }
  if (onchain?.ok && onchain.value.kind === "paid") {
    const received = (onchain.value.received + summary.paid).toString();
    return summary.paid > 0n
      ? {
          state: "paid",
          method: "mixed",
          received,
          txids: onchain.value.txids,
          preimages: summary.preimages
        }
      : { state: "paid", method: "onchain", received, txids: onchain.value.txids };
  }
  if (onchain?.ok && onchain.value.kind === "unconfirmed") {
    return {
      state: "unconfirmed",
      received: (onchain.value.received + summary.paid).toString(),
      confirmations: onchain.value.confirmations,
      txids: onchain.value.txids
    };
  }
  if (lightning && !lightning.ok) throw lightning.error;
  if (summary.error) throw summary.error.error;
  if (onchain && !onchain.ok) throw onchain.error;
  const underpaid = onchain?.ok && onchain.value.kind === "underpaid" ? onchain.value : null;
  const received = (underpaid?.received ?? 0n) + summary.paid;
  const lightningFinal = lightning === null || lightning.value.state === "expired";
  const onchainFinal = onchain === null || underpaid?.final === true;
  if (lightningFinal && onchainFinal && summary.final) {
    return { state: "expired", received: received.toString() };
  }
  return {
    state: "open",
    expiresAt: invoice.expiresAt,
    received: received.toString(),
    rest:
      invoice.address === null
        ? null
        : restOf({
            sats: invoice.sats,
            expiresAt: invoice.expiresAt,
            address: invoice.address,
            received,
            now,
            rests: (rests?.invoices ?? []).filter(
              ({ paymentHash }) => !rests?.unrecorded?.has(paymentHash)
            ),
            paid: summary.hashes
          })
  };
}
