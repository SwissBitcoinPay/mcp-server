import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import { deriveKey, outerKey, registryAddress } from "../../../vendor/checkout-node/src/derive.js";
import { getJson } from "../../../vendor/checkout-node/src/http.js";
import { decodeBolt11 } from "../../../vendor/checkout-node/src/lightning/bolt11.js";
import { publicKeyOf, type NostrEvent } from "../../../vendor/checkout-node/src/nostr/event.js";
import {
  NewerRecordError,
  dTagOf,
  openRecord,
  recordsThatOpen,
  replaces
} from "../../../vendor/checkout-node/src/nostr/record.js";
import { isDepositAddress } from "../../../vendor/checkout-node/src/onchain/address.js";
import type { BitcoinNode } from "../../../vendor/checkout-node/src/onchain/node.js";
import {
  DECLARATION_RECORD_TYPE,
  RECORD_KIND,
  SALE_NOSTR_SECRET_INFO,
  SALE_SALT
} from "../../../vendor/checkout-node/src/protocol.js";

import type { Call } from "../../protocol/context.js";
import { AssistantError } from "../../protocol/errors.js";
import { readOnchain } from "../../protocol/follow/chain.js";
import { readAcceptance } from "../../protocol/follow/sale.js";
import type { Signer } from "../../protocol/keys.js";
import type { GrantSeat } from "../grant.js";
import { isObject } from "../../protocol/text.js";
import type { Line, LineFiat, LinePayment } from "../lines.js";

/*
 * The sales of the merchant's points of sale (SPEC.md §20, The sales of the points of sale), from
 * the records each device of the business publishes of its sales (the app's
 * src/lib/team/member-records.ts: `team-sale`, `team-sale-onchain`, `team-sale-tx`), each payment
 * checked before it counts: a Lightning invoice with the preimage of its hash (the proof its
 * device joined to its paid record, else the Lightning address's LUD-21 answer) and declared in the
 * registry by that sale alone; a transaction its device saw paying the sale's address, 3 blocks deep
 * on the merchant's explorer. A sale is a line once its records say it paid, or underpaid and
 * accepted by the merchant, as « Portefeuille » tells it « Payée »; one whose payment cannot be
 * proven is set aside, never a line nor left out unsaid.
 */

const SALE_TYPE = "team-sale";
const ONCHAIN_SALE_TYPE = "team-sale-onchain";
const SALE_TX_TYPE = "team-sale-tx";

/** How far apart the records of one sale may be dated (the app's SALE_SPAN_SECONDS). */
export const SALE_SPAN_SECONDS = 24 * 3600;
/** Depth from which a transaction counts (spec/SPEC.md §31). */
const CONFIRMATIONS = 3;
const MAX_SALE_PROOFS = 50;
const MAX_PROOF_INVOICE_LENGTH = 4096;
const MAX_UNDERPAID_TRANSACTIONS = 20;
const MAX_NOTE_LENGTH = 200;
const HOUR_SECONDS = 3600;
/** Registry addresses read at once (one filter): a relay sends all their events, page by page. */
const ADDRESSES_PER_READ = 100;
const HEX_32 = /^[0-9a-f]{64}$/;
const SATS = /^(0|[1-9][0-9]{0,15})$/;
const POSITIVE_SATS = /^[1-9][0-9]{0,15}$/;

/** A device of the business that takes sales, with the keys of its records (the grant's). */
export type TillSeat = {
  /** « Par » of its sales: « Vous » for the owner's devices, an employee's name. */
  by: NonNullable<Line["by"]>;
  /** Author of its sales' records. */
  author: string;
  encryptionKey: string;
  addressKey: string;
  /**
   * Unix seconds: when the merchant removed it (its records count for the sales its device saw
   * before, as the app's markVouches); null while it is in the team.
   */
  removedAt: number | null;
};

/** The devices of `seats` that take sales: the owner's devices and the employees. */
export function tillSeatsOf(seats: readonly GrantSeat[]): TillSeat[] {
  return seats.flatMap((seat): TillSeat[] =>
    seat.role === "owner" || seat.role === "employee"
      ? [
          {
            by: seat.role === "owner" ? { kind: "you" } : { kind: "seat", name: seat.name },
            author: seat.records.sales,
            encryptionKey: seat.records.encryptionKey,
            addressKey: seat.records.addressKey,
            removedAt: seat.removedAt
          }
        ]
      : []
  );
}

/** A sale paid or accepted whose payment could not be proven: told apart, never a line. */
export type SetAside = {
  sale: string;
  /** Unix seconds: when its device saw it paid (or underpaid). */
  at: number;
  note: string;
  /** The sale's own amount; null when not told (a sale in sats, or not read). */
  fiat: LineFiat | null;
  by: NonNullable<Line["by"]>;
  reason:
    /** No proof joined and the Lightning address does not tell it paid (now). */
    | "unproven"
    /** Another sale declared one of its invoices: the merchant settles it. */
    | "conflict"
    /** Paid on-chain, its transaction not 3 blocks deep yet. */
    | "confirming"
    /** An integration's order paid on-chain: the merchant's app tells it. */
    | "onchain";
};

export type TillLines = { lines: Line[]; setAside: SetAside[] };

type Underpaid = { at: number; transactions: string[] };

type SaleRecord = {
  seat: TillSeat;
  /** Hex: the invoice's payment hash; null for an hour that showed the address alone. */
  paymentHash: string | null;
  verifyUrl: string | null;
  onchainAddress: string | null;
  hour: number | null;
  sats: bigint;
  fiat: LineFiat;
  note: string;
  createdAt: number;
  paidAt: number | null;
  sale: string;
  underpaid: Underpaid | null;
  saleKey: string | null;
  /** Undefined: written by an app from before the proofs. */
  lightning: { invoice: string; preimage: string }[] | undefined;
};

type Sighting = { address: string; txid: string; at: number };

const isSeconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function recordAddress(seat: TillSeat, subject: string): string {
  return bytesToHex(hmac(sha256, hexToBytes(seat.addressKey), utf8ToBytes(subject)));
}

function versionOf(value: unknown): Record<string, unknown> | null {
  if (!isObject(value)) return null;
  if (typeof value.version === "number" && value.version > 1) throw new NewerRecordError();
  return value.version === 1 ? value : null;
}

function parseUnderpaid(value: unknown, createdAt: number): Underpaid | null | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) return null;
  const { at, received, due, transactions } = value;
  if (
    !isSeconds(at) ||
    at < createdAt ||
    typeof received !== "string" ||
    !SATS.test(received) ||
    !(due === null || (typeof due === "string" && SATS.test(due))) ||
    !Array.isArray(transactions) ||
    transactions.length > MAX_UNDERPAID_TRANSACTIONS ||
    !transactions.every((txid) => typeof txid === "string" && HEX_32.test(txid))
  ) {
    return null;
  }
  return { at, transactions: [...(transactions as string[])] };
}

function parseProofs(value: unknown, paidAt: unknown): SaleRecord["lightning"] | null {
  if (value === undefined) return undefined;
  if (paidAt === null || !Array.isArray(value) || value.length > MAX_SALE_PROOFS) return null;
  const proofs: { invoice: string; preimage: string }[] = [];
  for (const entry of value as unknown[]) {
    if (!isObject(entry)) return null;
    const { invoice, preimage } = entry;
    if (
      typeof invoice !== "string" ||
      invoice.length === 0 ||
      invoice.length > MAX_PROOF_INVOICE_LENGTH ||
      typeof preimage !== "string" ||
      !HEX_32.test(preimage) ||
      proofs.some((known) => known.invoice === invoice)
    ) {
      return null;
    }
    proofs.push({ invoice, preimage });
  }
  return proofs;
}

/** What every record of a sale says (the app's parseSaleFields); null when invalid. */
function parseFields(
  v: Record<string, unknown>,
  seat: TillSeat
): Omit<SaleRecord, "paymentHash" | "verifyUrl" | "onchainAddress" | "hour"> | null {
  const { fiat } = v;
  const underpaid = isSeconds(v.createdAt) ? parseUnderpaid(v.underpaid, v.createdAt) : null;
  const lightning = parseProofs(v.lightning, v.paidAt);
  if (
    underpaid === null ||
    lightning === null ||
    typeof v.sale !== "string" ||
    !HEX_32.test(v.sale) ||
    typeof v.sats !== "string" ||
    !POSITIVE_SATS.test(v.sats) ||
    !isObject(fiat) ||
    !Number.isSafeInteger(fiat.minor) ||
    (fiat.minor as number) <= 0 ||
    !Number.isInteger(fiat.digits) ||
    (fiat.digits as number) < 0 ||
    (fiat.digits as number) > 4 ||
    typeof fiat.currency !== "string" ||
    !/^[A-Z]{3}$/.test(fiat.currency) ||
    typeof v.note !== "string" ||
    v.note.length > MAX_NOTE_LENGTH ||
    !isSeconds(v.createdAt) ||
    !isSeconds(v.expiresAt) ||
    !(v.paidAt === null || isSeconds(v.paidAt)) ||
    !(v.saleKey === undefined || (typeof v.saleKey === "string" && HEX_32.test(v.saleKey)))
  ) {
    return null;
  }
  return {
    seat,
    sats: BigInt(v.sats),
    fiat: { minor: fiat.minor as number, digits: fiat.digits as number, currency: fiat.currency },
    note: v.note,
    createdAt: v.createdAt,
    paidAt: v.paidAt,
    sale: v.sale,
    underpaid: underpaid ?? null,
    saleKey: typeof v.saleKey === "string" ? v.saleKey : null,
    lightning
  };
}

/** A record of an invoice of a sale (`team-sale`) at `d`; null when invalid or elsewhere. */
function parseSale(value: unknown, seat: TillSeat, d: string): SaleRecord | null {
  const v = versionOf(value);
  const fields = v ? parseFields(v, seat) : null;
  if (
    !v ||
    !fields ||
    typeof v.paymentHash !== "string" ||
    !HEX_32.test(v.paymentHash) ||
    typeof v.verifyUrl !== "string" ||
    !v.verifyUrl.startsWith("https://") ||
    !(v.onchainAddress === null || isDepositAddress(v.onchainAddress)) ||
    d !== recordAddress(seat, `sale:${v.paymentHash}`)
  ) {
    return null;
  }
  return {
    ...fields,
    paymentHash: v.paymentHash,
    verifyUrl: v.verifyUrl,
    onchainAddress: v.onchainAddress,
    hour: null
  };
}

/** A record of an hour of a sale that showed its address alone (`team-sale-onchain`). */
function parseOnchainSale(value: unknown, seat: TillSeat, d: string): SaleRecord | null {
  const v = versionOf(value);
  const fields = v ? parseFields(v, seat) : null;
  if (
    !v ||
    !fields ||
    !Number.isSafeInteger(v.hour) ||
    (v.hour as number) <= 0 ||
    (v.hour as number) % HOUR_SECONDS !== 0 ||
    !isDepositAddress(v.onchainAddress) ||
    d !== recordAddress(seat, `sale-onchain:${fields.sale}:${v.hour as number}`)
  ) {
    return null;
  }
  return {
    ...fields,
    paymentHash: null,
    verifyUrl: null,
    onchainAddress: v.onchainAddress,
    hour: v.hour as number
  };
}

/** A transaction a device saw paying one of its sales' addresses (`team-sale-tx`). */
function parseSighting(value: unknown, seat: TillSeat, d: string) {
  const v = versionOf(value);
  if (!v || !isDepositAddress(v.address) || typeof v.txid !== "string" || !HEX_32.test(v.txid)) {
    return null;
  }
  return d === recordAddress(seat, `sale-tx:${v.address}:${v.txid}`)
    ? { address: v.address, txid: v.txid }
    : null;
}

/** The registry identity of the sale whose own key is `saleKey` (hex). */
export function identityOf(saleKey: string): string {
  return publicKeyOf(deriveKey(hexToBytes(saleKey), SALE_SALT, SALE_NOSTR_SECRET_INFO));
}

/** What the till records of the period are, read once. */
async function readRecords(
  call: Call,
  relays: readonly string[],
  seats: readonly TillSeat[],
  auth: Signer,
  window: { start: number; end: number }
): Promise<{ records: SaleRecord[]; sightings: Sighting[] }> {
  const byAuthor = new Map(seats.map((seat) => [seat.author, seat]));
  const { answers, answered } = await call.pool.queryRelays(
    relays,
    {
      kinds: [RECORD_KIND],
      authors: [...byAuthor.keys()],
      since: window.start,
      until: window.end
    },
    auth.secretKey,
    {
      paged: true,
      keep: recordsThatOpen((_, author) => {
        const seat = byAuthor.get(author);
        return seat ? hexToBytes(seat.encryptionKey) : null;
      })
    }
  );
  if (!answered) {
    throw new AssistantError("network", "Fewer than a majority of the merchant's relays answered");
  }
  // Of each record (its author and address), the newest copy.
  const newest = new Map<string, { event: NostrEvent; record: SaleRecord | Sighting }>();
  for (const events of answers.values()) {
    for (const event of events) {
      const author = isObject(event) && typeof event.pubkey === "string" ? event.pubkey : "";
      const seat = byAuthor.get(author);
      const d = dTagOf(event);
      if (!seat || d === null) continue;
      const encryptionKey = hexToBytes(seat.encryptionKey);
      const options = { encryptionKey, address: d, author };
      const opened =
        openRecord(event, {
          ...options,
          type: SALE_TYPE,
          parse: (value) => parseSale(value, seat, d)
        }) ??
        openRecord(event, {
          ...options,
          type: ONCHAIN_SALE_TYPE,
          parse: (value) => parseOnchainSale(value, seat, d)
        }) ??
        openRecord(event, {
          ...options,
          type: SALE_TX_TYPE,
          parse: (value, ev): Sighting | null => {
            const seen = parseSighting(value, seat, d);
            return seen ? { ...seen, at: ev.created_at } : null;
          }
        });
      if (!opened) continue;
      // A sale's record of a newer format: this server cannot tell that sale.
      if (opened.status === "newer") {
        throw new AssistantError("newer", "A sale's record is of a newer format");
      }
      const key = `${author}/${d}`;
      const known = newest.get(key);
      if (!known || replaces(opened.event, known.event)) {
        newest.set(key, { event: opened.event, record: opened.value });
      }
    }
  }
  const records: SaleRecord[] = [];
  const sightings: Sighting[] = [];
  for (const { record } of newest.values()) {
    if ("txid" in record) sightings.push(record);
    else records.push(record);
  }
  return { records, sightings };
}

/** A Lightning payment of a sale, once proven. */
type Proven = { paymentHash: string; sats: bigint; paidAt: number };

/** A proof (an invoice and its preimage) of `hashes`' invoices: its payment, or null. */
function provenBy(
  proof: { invoice: string; preimage: string },
  hashes: ReadonlySet<string>,
  paidAt: number
): Proven | null {
  let invoice;
  try {
    invoice = decodeBolt11(proof.invoice);
  } catch {
    return null;
  }
  if (
    !invoice ||
    invoice.network !== "bc" ||
    invoice.amountMsat === null ||
    invoice.amountMsat <= 0n ||
    invoice.amountMsat % 1000n !== 0n ||
    !hashes.has(invoice.paymentHash) ||
    bytesToHex(sha256(hexToBytes(proof.preimage))) !== invoice.paymentHash
  ) {
    return null;
  }
  return { paymentHash: invoice.paymentHash, sats: invoice.amountMsat / 1000n, paidAt };
}

/**
 * The payment of `record`'s invoice as its Lightning address's LUD-21 answer tells it (a record of
 * an app from before the proofs): its invoice (`pr`) of that hash, settled, with its preimage; null
 * when it does not tell so (any failure included: the sale is set aside).
 */
async function provenByService(call: Call, record: SaleRecord): Promise<Proven | null> {
  try {
    const { ok, body } = await getJson(record.verifyUrl!, call.http);
    if (!ok || !isObject(body) || body.settled !== true) return null;
    const { pr, preimage } = body;
    if (typeof pr !== "string" || typeof preimage !== "string") return null;
    return provenBy(
      { invoice: pr, preimage: preimage.toLowerCase() },
      new Set([record.paymentHash!]),
      record.paidAt!
    );
  } catch {
    return null;
  }
}

/**
 * For each payment hash, the authors whose records at its registry address open as a declaration's
 * outside (spec/SPEC.md §20), read whole on a majority. Throws `network` otherwise.
 */
async function declarers(
  call: Call,
  relays: readonly string[],
  registryKey: Uint8Array,
  hashes: readonly string[],
  auth: Signer
): Promise<Map<string, Set<string>>> {
  const found = new Map<string, Set<string>>(hashes.map((hash) => [hash, new Set<string>()]));
  const hashOf = new Map(hashes.map((hash) => [registryAddress(registryKey, hash), hash]));
  const addresses = [...hashOf.keys()];
  for (let first = 0; first < addresses.length; first += ADDRESSES_PER_READ) {
    const chunk = addresses.slice(first, first + ADDRESSES_PER_READ);
    const { answers, answered } = await call.pool.queryRelays(
      relays,
      { kinds: [RECORD_KIND], "#d": chunk },
      auth.secretKey,
      {
        paged: true,
        keep: recordsThatOpen((d, author) =>
          d !== null && hashOf.has(d) ? outerKey(registryKey, d, author) : null
        )
      }
    );
    if (!answered) {
      throw new AssistantError(
        "network",
        "Fewer than a majority of the merchant's relays answered"
      );
    }
    for (const events of answers.values()) {
      for (const event of events) {
        const d = dTagOf(event);
        const author = isObject(event) && typeof event.pubkey === "string" ? event.pubkey : null;
        const hash = d === null ? undefined : hashOf.get(d);
        if (hash === undefined || author === null) continue;
        const opened = openRecord(event, {
          type: DECLARATION_RECORD_TYPE,
          encryptionKey: outerKey(registryKey, d!, author),
          address: d!,
          author,
          parse: (outside) =>
            isObject(outside) && typeof outside.sealed === "string" ? true : null
        });
        // A declaration of a newer format is still a declaration: its author declared it.
        if (opened) found.get(hash)!.add(author);
      }
    }
  }
  return found;
}

export type TillOptions = {
  relays: readonly string[];
  seats: readonly TillSeat[];
  auth: Signer;
  /** The merchant's registry key and link owner key (the channel's). */
  registryKey: string;
  linkOwner: string;
  bitcoinNode: BitcoinNode | null;
  range: { start: number; end: number };
};

/**
 * The lines of the sales of the points of sale paid within `range`, and those set aside. Throws
 * `network` when the relays or the explorer could not tell what is needed, `newer` for a record
 * of a newer format.
 */
export async function readTillLines(call: Call, options: TillOptions): Promise<TillLines> {
  const { relays, seats, auth, range } = options;
  if (seats.length === 0) return { lines: [], setAside: [] };
  const now = call.now();
  const { records, sightings } = await readRecords(call, relays, seats, auth, {
    start: Math.max(0, range.start - SALE_SPAN_SECONDS),
    end: Math.min(range.end + SALE_SPAN_SECONDS, now)
  });
  const bySale = new Map<string, SaleRecord[]>();
  for (const record of records) {
    const group = bySale.get(record.sale) ?? [];
    group.push(record);
    bySale.set(record.sale, group);
  }

  // Each sale paid, or underpaid and accepted by the merchant, of the period.
  type Judged = {
    sale: string;
    group: SaleRecord[];
    /** The record that tells it: its paid record (the latest), else its latest underpayment's. */
    record: SaleRecord;
    paid: boolean;
    /** When its device saw it paid (or underpaid). */
    seenAt: number;
    /** The latest underpayment its records tell. */
    underpaid: Underpaid | null;
    lightning: Proven[];
    /** A proof its records give does not prove its payment. */
    unproven: boolean;
  };
  const judged: Judged[] = [];
  for (const [sale, group] of bySale) {
    const paidRecords = group.filter((record) => record.paidAt !== null);
    let paid: SaleRecord | null = null;
    for (const record of paidRecords) if (!paid || record.paidAt! > paid.paidAt!) paid = record;
    let underpaid: { record: SaleRecord; underpaid: Underpaid } | null = null;
    for (const record of group) {
      if (record.underpaid && (!underpaid || record.underpaid.at > underpaid.underpaid.at)) {
        underpaid = { record, underpaid: record.underpaid };
      }
    }
    const record = paid ?? underpaid?.record;
    if (!record) continue;
    const seenAt = paid ? paid.paidAt! : underpaid!.underpaid.at;
    // A device removed from the team vouches for what it saw before only.
    if (record.seat.removedAt !== null && seenAt > record.seat.removedAt) continue;
    // A payment is dated when it was made, never after its device saw it: a sale seen before the
    // period is none of its lines; one shown after it neither.
    if (seenAt < range.start) continue;
    if (Math.min(...group.map(({ createdAt }) => createdAt)) > range.end) continue;
    const hashes = new Set(group.flatMap(({ paymentHash }) => (paymentHash ? [paymentHash] : [])));
    const lightning: Proven[] = [];
    let unproven = false;
    for (const paidRecord of paidRecords) {
      if (paidRecord.lightning === undefined) {
        // An app from before the proofs: its Lightning address tells it, for an invoice's record.
        if (paidRecord.paymentHash === null) continue;
        const proven = await provenByService(call, paidRecord);
        if (proven) lightning.push(proven);
        continue;
      }
      for (const proof of paidRecord.lightning) {
        const proven = provenBy(proof, hashes, paidRecord.paidAt!);
        if (proven) lightning.push(proven);
        else unproven = true;
      }
    }
    judged.push({
      sale,
      group,
      record,
      paid: paid !== null,
      seenAt,
      underpaid: underpaid?.underpaid ?? null,
      lightning,
      unproven
    });
  }

  // Every Lightning payment counts only when its sale alone declared it (spec/SPEC.md §22).
  const declared = await declarers(
    call,
    relays,
    hexToBytes(options.registryKey),
    [...new Set(judged.flatMap(({ lightning }) => lightning.map((p) => p.paymentHash)))],
    auth
  );

  const lines: Line[] = [];
  const setAside: SetAside[] = [];
  const inRange = (at: number) => at >= range.start && at <= range.end;
  for (const sale of judged) {
    const { record } = sale;
    const aside = (reason: SetAside["reason"]) => {
      if (!inRange(sale.seenAt)) return;
      setAside.push({
        sale: sale.sale,
        at: sale.seenAt,
        note: record.note,
        fiat: record.fiat,
        by: record.seat.by,
        reason
      });
    };
    // Underpaid: a line only once the merchant accepted it (read below, with what it received).
    let accepted: { received: bigint; due: bigint; at: number } | null = null;
    if (!sale.paid) {
      const saleKey = sale.group.map((r) => r.saleKey).find((key) => key !== null) ?? null;
      if (saleKey === null || identityOf(saleKey) !== sale.sale) continue;
      const read = await readAcceptance(
        call.pool,
        relays,
        options.linkOwner,
        hexToBytes(saleKey),
        auth.secretKey
      );
      if (read === undefined) {
        throw new AssistantError(
          "network",
          "Fewer than a majority of the merchant's relays answered"
        );
      }
      if (read === null) continue;
      accepted = read;
    }
    const conflict = sale.lightning.some(({ paymentHash }) =>
      [...declared.get(paymentHash)!].some((author) => author !== sale.sale)
    );
    if (conflict) {
      aside("conflict");
      continue;
    }
    // Declared by no sale (not even its own): nothing tells it the sale's.
    if (
      sale.unproven ||
      sale.lightning.some(({ paymentHash }) => declared.get(paymentHash)!.size === 0)
    ) {
      aside("unproven");
      continue;
    }
    // Its transactions: those its devices saw paying its addresses, and those its latest
    // underpayment counted (the app's transactionsOf); each counted 3 blocks deep on the explorer.
    const addresses = new Set(
      sale.group.flatMap(({ onchainAddress }) => (onchainAddress ? [onchainAddress] : []))
    );
    const named = new Set([
      ...sightings.filter(({ address }) => addresses.has(address)).map(({ txid }) => txid),
      ...(sale.underpaid?.transactions ?? [])
    ]);
    const onchain: LinePayment[] = [];
    let confirming = false;
    if (named.size > 0) {
      for (const address of addresses) {
        const read = await readOnchain(address, options.bitcoinNode, call.http, () => now * 1000);
        if (!read.ok) {
          throw new AssistantError("network", "The explorer could not tell a sale's payments");
        }
        for (const payment of read.payments) {
          if (!named.has(payment.txid)) continue;
          if (payment.confirmations < CONFIRMATIONS) {
            confirming = true;
            continue;
          }
          onchain.push({
            id: payment.txid,
            direction: "receive",
            status: "completed",
            amountSats: payment.sats.toString(),
            feeSats: "0",
            timestamp: Math.floor(payment.at / 1000),
            network: "bitcoin",
            paymentHash: null,
            txId: payment.txid,
            lightningAddress: null,
            description: null
          });
        }
      }
    }
    if (confirming) {
      aside("confirming");
      continue;
    }
    const payments: LinePayment[] = [
      ...sale.lightning.map((paid): LinePayment => ({
        id: paid.paymentHash,
        direction: "receive",
        status: "completed",
        amountSats: paid.sats.toString(),
        feeSats: "0",
        timestamp: paid.paidAt,
        network: "lightning",
        paymentHash: paid.paymentHash,
        txId: null,
        lightningAddress: null,
        description: null
      })),
      ...onchain
    ].sort((a, b) => b.timestamp - a.timestamp || (a.id < b.id ? -1 : 1));
    const received = payments.reduce((total, p) => total + BigInt(p.amountSats), 0n);
    if (received === 0n) {
      // Told paid (or accepted), nothing of it proven: never a line of 0.
      aside("unproven");
      continue;
    }
    // An acceptance counts while the sale received at least what it had then (the app's).
    if (accepted && received < accepted.received) continue;
    const at = payments[0]!.timestamp;
    if (!inRange(at)) continue;
    lines.push({
      id: `sale:${sale.sale}`,
      source: "pos",
      at,
      note: record.note,
      invoice: null,
      by: record.seat.by,
      payments,
      sats: received.toString(),
      // Accepted: what it received, as the point of sale splits the sale's amount.
      fiat: accepted
        ? { ...record.fiat, minor: receivedMinor(record.fiat.minor, accepted.due, received) }
        : record.fiat,
      rate: null,
      imported: false,
      acceptance: accepted && {
        received: accepted.received.toString(),
        due: accepted.due.toString(),
        at: accepted.at,
        fiat: record.fiat
      }
    });
  }
  // In a stable order, whatever the relays' (the oldest first, then by sale).
  const order = (a: { at: number; key: string }, b: { at: number; key: string }) =>
    a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return {
    lines: lines.sort((a, b) => order({ at: a.at, key: a.id }, { at: b.at, key: b.id })),
    setAside: setAside.sort((a, b) => order({ at: a.at, key: a.sale }, { at: b.at, key: b.sale }))
  };
}

/** The share of `minor` that `received` of `due` pays (the app's splitFiat, receivedMinor). */
export function receivedMinor(minor: number, due: bigint, received: bigint): number {
  if (due <= 0n || received <= 0n) return 0;
  return received >= due ? minor : Number((BigInt(minor) * received) / due);
}
