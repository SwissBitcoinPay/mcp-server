import { openDeclaration, type DeclaredPrice, type OpenedDeclaration } from "./declaration.js";
import { outerKey, type Sale } from "./derive.js";
import { NetworkError } from "./errors.js";
import { hasValidId, type NostrEvent } from "./nostr/event.js";
import { dTagOf as dTag, NewerRecordError, recordsThatOpen, replaces } from "./nostr/record.js";
import { paymentUri } from "./onchain/address.js";
import {
  isConfirmedLease,
  openSaleLease,
  type OpenedLease,
  type SaleLeaseRecord
} from "./onchain/lease.js";
import { byRestOrder, restInvoiceOf, type RestInvoice } from "./onchain/rest.js";
import { majority, type RelayPool } from "./nostr/relay.js";
import { GRACE_SECONDS, RECORD_KIND, SATS_CURRENCY } from "./protocol.js";
import { formatDecimal } from "./rates.js";
import { asciiLower, isObject } from "./text.js";
import type { DeclaredInvoice, Fiat, Logger } from "./types.js";

/*
 * The invoices declared for a sale, read back from the merchant's registry (SPEC.md, "One order,
 * one invoice at a time"): its declarations and its leases of deposit addresses. What createInvoice
 * checks before a new invoice, and findInvoices gives.
 */

/**
 * A declared invoice, with its signed declaration (null for an order paid on-chain only) and lease
 * (null without an address): published again when the invoice may still be paid.
 */
export type SaleDeclaration = {
  invoice: DeclaredInvoice;
  event: NostrEvent | null;
  lease: NostrEvent | null;
};

/** What the registry holds of a sale (readSaleDeclarations). */
export type SaleRecords = {
  /** The order's invoices, oldest first. */
  invoices: SaleDeclaration[];
  /**
   * The rest invoices of each invoice with an address (SPEC.md, "The rest of an underpayment"),
   * by restKeyOf of that invoice (its address and end): its declarations with `rest`, by date then
   * payment hash.
   */
  rests: Map<string, RestInvoice[]>;
  /**
   * The declarations of rest invoices fewer than a majority of the merchant's relays sent, by
   * payment hash: their publication may have reached a minority only (it failed), and a later read
   * may miss them. Published again on a majority before they are used.
   */
  unsureRests: Map<string, NostrEvent>;
  /** The sale's leases still held (not withdrawn), by address: the order's terms. */
  leases: Map<string, OpenedLease>;
  /** How many relays sent each event, by id: of a read on every relay, which relays hold it. */
  sentBy: ReadonlyMap<string, number>;
};

/**
 * The invoices of `sale` on `relays`, oldest first (by date, then payment hash, then address):
 * read page after page as soon as a majority of the relays answered (each declaration and lease is
 * on a majority of them). One per payment hash, with the address of the sale's confirmed lease
 * naming its invoice; and one per confirmed lease of an order paid on-chain only (invoicesOf). A lease
 * naming an invoice without a declaration is left out: that invoice was never shown. A declaration
 * with `rest` is no invoice of the order: one of the rest invoices of the invoice it names.
 * Throws NetworkError when fewer than a majority answered.
 */
export async function readSaleDeclarations(
  pool: RelayPool,
  sale: Sale,
  relays: readonly string[],
  {
    signal,
    logger,
    everyRelay = false
  }: { signal?: AbortSignal | undefined; logger: Logger; everyRelay?: boolean }
): Promise<SaleRecords> {
  const needed = majority(relays.length);
  // With everyRelay, on every relay (SPEC.md §13): which relays hold a record.
  const { answers, answered } = await pool.queryRelays(
    relays,
    { kinds: [RECORD_KIND], authors: [sale.author] },
    sale.secretKey,
    {
      paged: true,
      everyRelay,
      // Its declarations and its records at registry addresses: sealed with the outer key of their
      // address and of the sale.
      keep: recordsThatOpen((d, author) =>
        author === sale.author && d !== null ? outerKey(sale.registry.key, d, author) : null
      )
    }
  );
  if (signal?.aborted) throw signal.reason;
  if (!answered) {
    throw new NetworkError("Fewer than a majority of the merchant's relays answered");
  }
  const declarations = new Map<string, OpenedDeclaration>();
  /** The sale's records at registry addresses of addresses. */
  const records: SaleLeaseRecord[] = [];
  // Event ids that checked out: another copy of one is the same event, not opened again.
  const checked = new Set<string>();
  /** How many relays sent each event (by id). */
  const sentBy = new Map<string, number>();
  let newer = false;
  for (const events of answers.values()) {
    // A relay counts for an event when it sent a copy whose id is its hash: it holds that event.
    const ids = new Set<string>();
    for (const value of events) if (hasValidId(value)) ids.add(value.id);
    for (const id of ids) sentBy.set(id, (sentBy.get(id) ?? 0) + 1);
    for (const value of events) {
      if (isObject(value) && typeof value.id === "string" && checked.has(value.id)) continue;
      let declaration: OpenedDeclaration | null;
      let lease: SaleLeaseRecord | null = null;
      try {
        declaration = openDeclaration(value, sale);
        if (!declaration) lease = openSaleLease(value, sale);
      } catch (error) {
        if (!(error instanceof NewerRecordError)) continue;
        newer = true;
        // Authentic (its signature checked before its format), at a registry address: the newest
        // there, it leaves no lease of the sale.
        const d = dTag(value);
        if (d !== null) {
          const event = value as NostrEvent;
          checked.add(event.id);
          records.push({ kind: "newer", event, d });
        }
        continue;
      }
      if (declaration) {
        checked.add(declaration.event.id);
        const hash = declaration.decoded.paymentHash;
        if (!declarations.has(hash)) declarations.set(hash, declaration);
      } else if (lease) {
        checked.add(leaseEventOf(lease).id);
        records.push(lease);
      }
    }
  }
  if (newer) {
    logger.warn(
      "@sattleme/checkout: a declaration or a lease of this order has a newer format " +
        "than this version reads; update the package"
    );
  }
  const newest = newestRecords(records);
  const held = newest.flatMap((record) => (record.kind === "lease" ? [record.lease] : []));
  const rests = new Map<string, RestInvoice[]>();
  const unsureRests = new Map<string, NostrEvent>();
  const invoices: OpenedDeclaration[] = [];
  for (const declaration of declarations.values()) {
    if (declaration.rest === null) {
      invoices.push(declaration);
      continue;
    }
    if ((sentBy.get(declaration.event.id) ?? 0) < needed) {
      unsureRests.set(declaration.decoded.paymentHash, declaration.event);
    }
    const key = restKeyOf(declaration.rest.address, declaration.rest.expiresAt);
    const list = rests.get(key);
    if (list) list.push(restInvoiceOf(declaration));
    else rests.set(key, [restInvoiceOf(declaration)]);
  }
  for (const list of rests.values()) list.sort(byRestOrder);
  return {
    invoices: invoicesOf(sale.ref, invoices, newest),
    rests,
    unsureRests,
    leases: new Map(held.map((lease) => [lease.terms.address, lease])),
    sentBy
  };
}

/**
 * Of the sale's records at registry addresses, the newest at each (the highest `created_at`, then
 * the lowest id, as relays keep them): its lease there, or its withdrawal, which leaves none.
 */
export function newestRecords(records: Iterable<SaleLeaseRecord>): SaleLeaseRecord[] {
  const newest = new Map<string, SaleLeaseRecord>();
  for (const record of records) {
    const d = record.kind === "lease" ? record.lease.d : record.d;
    const known = newest.get(d);
    if (!known || replaces(leaseEventOf(record), leaseEventOf(known))) newest.set(d, record);
  }
  return [...newest.values()];
}

/**
 * The sale's invoices, oldest first (by date, then payment hash, none first, then address), from
 * its declarations (one per payment hash; one with `rest` gives none) and its newest record at
 * each registry address (newestRecords). Only a confirmed lease gives an address (SPEC.md,
 * "Leasing an address"): one that is not was left by a createInvoice that failed before the
 * address was the order's. One invoice per declaration, with the address of the newest confirmed
 * lease naming its invoice; and one per confirmed lease of an order paid on-chain only. A lease
 * naming an invoice without a declaration is left out: that invoice was never shown.
 */
export function invoicesOf(
  ref: string,
  declarations: Iterable<OpenedDeclaration>,
  newest: readonly SaleLeaseRecord[]
): SaleDeclaration[] {
  const confirmed = newest.flatMap((record) =>
    record.kind === "lease" && isConfirmedLease(record.lease.terms) ? [record.lease] : []
  );
  const found: SaleDeclaration[] = [];
  for (const declaration of declarations) {
    // A rest invoice's: no invoice of the order.
    if (declaration.rest !== null) continue;
    const { decoded } = declaration;
    const invoice = asciiLower(declaration.invoice);
    const lease = confirmed
      .filter(({ terms }) => terms.invoice !== null && asciiLower(terms.invoice) === invoice)
      .sort((a, b) => (replaces(a.event, b.event) ? -1 : 1))[0];
    const sats = decoded.amountMsat! / 1000n;
    const onchainAddress = lease?.terms.address ?? null;
    found.push({
      invoice: {
        ref,
        bolt11: declaration.invoice,
        paymentHash: decoded.paymentHash,
        verifyUrl: declaration.verifyUrl,
        onchainAddress,
        paymentUri: paymentUri(onchainAddress, sats, declaration.invoice),
        sats: sats.toString(),
        fiat: fiatOf(declaration.price),
        note: declaration.note,
        createdAt: decoded.timestamp,
        expiresAt: decoded.timestamp + decoded.expirySeconds,
        declaredAt: declaration.declaredAt
      },
      event: declaration.event,
      lease: lease?.event ?? null
    });
  }
  for (const lease of confirmed) {
    if (lease.terms.invoice !== null) continue;
    const { terms } = lease;
    found.push({
      invoice: {
        ref,
        bolt11: null,
        paymentHash: null,
        verifyUrl: null,
        onchainAddress: terms.address,
        paymentUri: paymentUri(terms.address, terms.sats, null),
        sats: terms.sats.toString(),
        fiat: fiatOf(terms.price),
        note: terms.note,
        createdAt: terms.createdAt,
        expiresAt: terms.expiresAt,
        // Its mark's date (SPEC.md, "Leasing an address").
        declaredAt: lease.event.created_at
      },
      event: null,
      lease: lease.event
    });
  }
  return found.sort(
    ({ invoice: a }, { invoice: b }) =>
      a.createdAt - b.createdAt ||
      compare(a.paymentHash ?? "", b.paymentHash ?? "") ||
      compare(a.onchainAddress ?? "", b.onchainAddress ?? "")
  );
}

/**
 * Step 1 of SPEC.md "One order, one invoice at a time": the indices of the invoices (oldest first)
 * that may still be paid at `now`, until their end and its grace period.
 */
export function mayStillBePaid(invoices: readonly DeclaredInvoice[], now: number): number[] {
  return invoices.flatMap(({ expiresAt }, index) =>
    now < expiresAt + GRACE_SECONDS ? [index] : []
  );
}

/**
 * An invoice's last record: its declaration, or for an invoice paid on-chain only its lease's event
 * (its mark). The one shown has it on a majority of the relays; one whose createInvoice failed
 * before that, on a minority.
 */
export function lastRecordOf(invoice: SaleDeclaration): NostrEvent {
  return invoice.event ?? invoice.lease!;
}

/**
 * Of `invoices` (those that may still be paid), whether a majority of the merchant's `relays`
 * (their count) sent the last record of each (lastRecordOf), from `sentBy`, how many relays sent
 * each event of the sale's records read on every relay (SPEC.md §21: the one shown is the one a
 * majority holds); null when that read was not answered by a majority, or not made.
 */
export function heldBy(
  invoices: readonly SaleDeclaration[],
  sentBy: ReadonlyMap<string, number> | null,
  relays: number
): boolean[] | null {
  if (sentBy === null) return null;
  const needed = majority(relays);
  return invoices.map((invoice) => (sentBy.get(lastRecordOf(invoice).id) ?? 0) >= needed);
}

/**
 * Of the invoices that may still be paid (oldest first, one or more), from the payment check of each
 * and, of several, whether a majority of the relays sent its last record (`held`, read on every
 * relay; null when fewer than a majority answered that read): the first paid gives order_paid,
 * whatever the read (a payment proves itself); else the first error is the error (that invoice may
 * have been paid); else, when the read was not answered by a majority, it is unread (network). Else
 * the one handed out is the only one; of several, the only one held (the one shown), else the newest
 * that received something (unconfirmed, or open with received above 0), else the newest.
 */
export function pendingOutcome(
  statuses: readonly PromiseSettledResult<{ state: string; received?: string }>[],
  held: readonly boolean[] | null
): { paid: number } | { failed: number } | { unread: true } | { handOut: number } {
  const paid = statuses.findIndex(
    (status) => status.status === "fulfilled" && status.value.state === "paid"
  );
  if (paid >= 0) return { paid };
  const failed = statuses.findIndex((status) => status.status === "rejected");
  if (failed >= 0) return { failed };
  if (statuses.length === 1) return { handOut: 0 };
  if (held === null) return { unread: true };
  const shown = held.flatMap((isHeld, index) => (isHeld ? [index] : []));
  if (shown.length === 1) return { handOut: shown[0]! };
  const received = statuses.findLastIndex(
    (status) =>
      status.status === "fulfilled" &&
      (status.value.state === "unconfirmed" ||
        (status.value.state === "open" && BigInt(status.value.received ?? "0") > 0n))
  );
  return { handOut: received >= 0 ? received : statuses.length - 1 };
}

/** The key, in SaleRecords.rests, of the invoice with `address` and the end `expiresAt`. */
export function restKeyOf(address: string, expiresAt: number): string {
  return `${address}/${expiresAt}`;
}

function leaseEventOf(record: SaleLeaseRecord): NostrEvent {
  return record.kind === "lease" ? record.lease.event : record.event;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The price of a declared sale as a Fiat: null for a sale in sats. */
function fiatOf(price: DeclaredPrice): Fiat | null {
  if (price.currency === SATS_CURRENCY) return null;
  return {
    amount: formatDecimal({ units: BigInt(price.minor), scale: price.digits }),
    currency: price.currency,
    minor: price.minor.toString(),
    digits: price.digits
  };
}
