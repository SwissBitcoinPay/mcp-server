import { bytesToHex } from "@noble/hashes/utils.js";

import type { DeclaredPrice } from "../declaration.js";
import { outerKey, type Sale } from "../derive.js";
import { readJson } from "../json.js";
import { decodeBolt11 } from "../lightning/bolt11.js";
import { hasValidId, signatureChecks, type NostrEvent } from "../nostr/event.js";
import { nip44Decrypt, nip44Encrypt } from "../nostr/nip44.js";
import {
  NewerRecordError,
  dTagOf as dTag,
  openRecord,
  replaces,
  sealRecord
} from "../nostr/record.js";
import type { RelayPool } from "../nostr/relay.js";
import {
  CLOCK_TOLERANCE_SECONDS,
  GRACE_SECONDS,
  LEASE_LOOKBACK_SECONDS,
  LEASE_RECORD_TYPE,
  LEASE_VERSION,
  MAX_DECLARED_DIGITS,
  MAX_SATS,
  RECORD_KIND
} from "../protocol.js";
import type { RandomBytes } from "../random.js";
import { isHex32, isObject } from "../text.js";
import { parseHttpsUrl } from "../urls.js";

import { isDepositAddress, leaseAddress } from "./address.js";
import { toleranceOf } from "./tolerance.js";

/*
 * Leases (SPEC.md, "Leases"): an order holds a deposit address of the lot for the time of its
 * invoice with a record in the merchant's registry, signed by the order's sale, at the address's
 * registry address. Outside, what anyone holding the registry key reads (when the lease ends, or
 * its withdrawal); inside, sealed to the merchant's reading key as a declaration's, the order's
 * terms. Like a declaration, a lease stays: a payment of its address in its time is the order's
 * for good.
 */

/** What a lease holds of its order (the lease's JSON, inside). */
export type LeaseTerms = {
  address: string;
  sats: bigint;
  /** The order's Lightning invoice and its verify URL, null for an order paid on-chain only. */
  invoice: string | null;
  verifyUrl: string | null;
  /** The Invoice's dates (Unix seconds). */
  createdAt: number;
  expiresAt: number;
  price: DeclaredPrice;
  /** The label: the note, else the reference. */
  note: string;
  /**
   * The order's tolerance of on-chain underpayments (basis points, tolerance.ts): the channel's
   * when the order was created, which judges its payment for good. 0: none (absent from the lease).
   */
  tolerance: number;
  /**
   * Whether the lease is marked confirmed (SPEC.md, "Leases"): false as first published, true once
   * confirmed; undefined when absent, which is not confirmed either.
   */
  confirmed?: boolean;
};

/** Whether a lease's terms make it confirmed: `confirmed` true, nothing else. */
export function isConfirmedLease(terms: LeaseTerms): boolean {
  return terms.confirmed === true;
}

/**
 * The lease of `terms.address` for `sale`, signed at `createdAt`; it ends at expiresAt + 120. Its
 * tolerance follows `taker` when it is above 0, and is absent otherwise.
 */
export function leaseEvent(input: {
  sale: Sale;
  terms: LeaseTerms;
  createdAt: number;
  random?: RandomBytes | undefined;
}): NostrEvent {
  const { sale, terms } = input;
  const inside = {
    version: LEASE_VERSION,
    address: terms.address,
    sats: Number(terms.sats),
    invoice: terms.invoice,
    verifyUrl: terms.verifyUrl,
    createdAt: terms.createdAt,
    expiresAt: terms.expiresAt,
    sale: { key: bytesToHex(sale.key), fiat: terms.price, note: terms.note },
    taker: sale.taker,
    ...(terms.tolerance > 0 ? { tolerance: terms.tolerance } : {}),
    ...(terms.confirmed === undefined ? {} : { confirmed: terms.confirmed })
  };
  return sealSaleRecord(
    sale,
    terms.address,
    {
      version: LEASE_VERSION,
      end: terms.expiresAt + GRACE_SECONDS,
      sealed: nip44Encrypt(JSON.stringify(inside), sale.innerKey, input.random)
    },
    input.createdAt,
    input.random
  );
}

/**
 * The withdrawal of `sale`'s lease of `address`, which replaces it (same author and `d` tag): its
 * `created_at` is strictly after the lease's.
 */
export function withdrawalEvent(input: {
  sale: Sale;
  address: string;
  createdAt: number;
  random?: RandomBytes | undefined;
}): NostrEvent {
  return sealSaleRecord(
    input.sale,
    input.address,
    { version: LEASE_VERSION, withdrawn: true },
    input.createdAt,
    input.random
  );
}

function sealSaleRecord(
  sale: Sale,
  address: string,
  value: unknown,
  createdAt: number,
  random: RandomBytes | undefined
): NostrEvent {
  const d = leaseAddress(sale.registry.key, address);
  return sealRecord({
    type: LEASE_RECORD_TYPE,
    value,
    signer: sale.secretKey,
    encryptionKey: outerKey(sale.registry.key, d, sale.author),
    address: d,
    createdAt,
    ...(random ? { random } : {})
  });
}

/** A record's outside, as anyone holding the registry key reads it. */
export type LeaseOutside =
  | { kind: "lease"; end: number; sealed: string }
  | { kind: "withdrawn" }
  /** Authentic, but of a newer format: an unreadable lease is never written over. */
  | { kind: "newer" };

function parseOutside(value: unknown): LeaseOutside | null {
  if (!isObject(value)) return null;
  if (typeof value.version === "number" && value.version > LEASE_VERSION) {
    throw new NewerRecordError();
  }
  if (value.version !== LEASE_VERSION) return null;
  if (value.withdrawn === true) return { kind: "withdrawn" };
  const { end, sealed } = value;
  if (typeof end !== "number" || !Number.isSafeInteger(end) || typeof sealed !== "string") {
    return null;
  }
  return { kind: "lease", end, sealed };
}

/**
 * What a read of leases keeps of a record's event, its id checked: what the walk of its address and
 * a lease's confirmation need, and its signature. A lease opens without its signature, so anybody
 * may send copies of one under ids of their own (another tag, another date): of each, only these
 * few bytes are kept, never its tags nor its content (SPEC.md §13, Limits).
 */
export type LeaseEvent = Pick<NostrEvent, "id" | "pubkey" | "created_at" | "sig">;

/** What a read of leases keeps of a record's outside: whether, and until when, it holds. */
export type LeaseHold = { kind: "lease"; end: number } | { kind: "withdrawn" } | { kind: "newer" };

/**
 * A record of the registry at a deposit address's registry address `d`, by any author: its id
 * checked, its signature not yet (SPEC.md, "Opening a lease"). `signed` checks it, once: whether a
 * copy of the event (its id) a relay sent carries a signature that checks out, so that a relay's
 * copy with a damaged signature never hides the valid one another relay sent (SPEC.md §11: a copy
 * that does not check out is ignored). `addCopy` takes the signature of another relay's copy of it.
 */
export type LeaseRecord = {
  event: LeaseEvent;
  d: string;
  outside: LeaseHold;
  signed: () => boolean;
  addCopy: (sig: string) => void;
};

/** `event`'s record at `d` with its outside, its signature checked when first asked. */
export function leaseRecordOf(event: LeaseEvent, d: string, outside: LeaseHold): LeaseRecord {
  const signatures = [event.sig];
  let signed: boolean | undefined;
  return {
    event,
    d,
    outside,
    signed: () =>
      (signed ??= signatures.some((sig) =>
        signatureChecks(sig === event.sig ? event : { ...event, sig })
      )),
    addCopy: (sig) => {
      // The same event (its id is its hash) with another signature: one more to try.
      if (signatures.includes(sig)) return;
      signatures.push(sig);
      if (signed === false) signed = undefined;
    }
  };
}

/**
 * What a relay sent, opened as a record of type `registry-onchain` at the registry address `d`,
 * with the outer key of `d` and of the event's own author (SPEC.md, "Opening a lease"): its id
 * first; a content of a newer NIP-44 version is no record here (anybody can write one at `d`); its
 * signature is left to `isLeased`, which checks it only where it decides. Null when it is not one.
 */
export function openLeaseRecord(
  value: unknown,
  registryKey: Uint8Array,
  d: string
): LeaseRecord | null {
  const opened = openLeaseOutside(value, registryKey, d);
  if (!opened) return null;
  const { event, outside } = opened;
  return leaseRecordOf(
    event,
    d,
    outside.kind === "lease" ? { kind: "lease", end: outside.end } : outside
  );
}

/** openLeaseRecord's opening, with the whole outside (its `sealed` included). */
export function openLeaseOutside(
  value: unknown,
  registryKey: Uint8Array,
  d: string
): { event: LeaseEvent; outside: LeaseOutside } | null {
  if (!hasValidId(value) || value.kind !== RECORD_KIND || dTag(value) !== d) return null;
  if (!isHex32(value.pubkey)) return null;
  let plaintext: string;
  try {
    plaintext = nip44Decrypt(value.content, outerKey(registryKey, d, value.pubkey));
  } catch {
    // A content of a newer NIP-44 version included: only the outer key seals a newer lease.
    return null;
  }
  let envelope: unknown;
  try {
    envelope = readJson(plaintext);
  } catch {
    return null;
  }
  if (!isObject(envelope) || !("v" in envelope) || envelope.t !== LEASE_RECORD_TYPE) {
    return null;
  }
  let outside: LeaseOutside | null;
  try {
    outside = parseOutside(envelope.v);
  } catch (error) {
    if (!(error instanceof NewerRecordError)) return null;
    outside = { kind: "newer" };
  }
  if (!outside) return null;
  const { id, pubkey, created_at, sig } = value;
  return { event: { id, pubkey, created_at, sig }, outside };
}

/** Whether `record` holds its address at `t` (a lease not ended, or of a newer format). */
function holds({ outside }: LeaseRecord, t: number): boolean {
  return (
    outside.kind === "newer" ||
    (outside.kind === "lease" && outside.end >= t - CLOCK_TOLERANCE_SECONDS)
  );
}

/**
 * Whether the records of one address lease it at `t` (SPEC.md, "Leases"): of each author, its
 * records from the newest (a withdrawal replaces its author's lease): one that holds the address
 * (a lease whose end is at most CLOCK_TOLERANCE before `t`, another server's clock may be behind,
 * or of a newer format) leases it; one that holds nothing ends the author's records, unless an
 * older one of them holds and its signature does not check out. A record that holds is never
 * checked for its signature: only a holder of the registry key seals one, and it may lease.
 */
export function isLeased(records: readonly LeaseRecord[], t: number): boolean {
  const byAuthor = new Map<string, LeaseRecord[]>();
  for (const record of records) {
    const list = byAuthor.get(record.event.pubkey);
    if (list) list.push(record);
    else byAuthor.set(record.event.pubkey, [record]);
  }
  let leased = false;
  // Every author walked, as the vectors count the signatures checked.
  for (const list of byAuthor.values()) {
    const walk = list.sort((a, b) => (replaces(a.event, b.event) ? -1 : 1));
    for (const [index, record] of walk.entries()) {
      if (holds(record, t)) {
        leased = true;
        break;
      }
      if (!walk.slice(index + 1).some((older) => holds(older, t))) break;
      if (record.signed()) break;
    }
  }
  return leased;
}

/**
 * Whether the lease `own` (an event of the sale `author`) is confirmed by `records`, a complete
 * read of its address's records (SPEC.md, "Leasing an address", step 3.3): no record of another
 * author holds the address at `t`, and `own` is the newest record of its author there.
 */
export function isConfirmed(records: readonly LeaseRecord[], own: LeaseEvent, t: number): boolean {
  if (!records.some(({ event }) => event.id === own.id)) return false;
  if (
    isLeased(
      records.filter(({ event }) => event.pubkey !== own.pubkey),
      t
    )
  )
    return false;
  return !records.some(
    ({ event }) => event.pubkey === own.pubkey && event.id !== own.id && replaces(event, own)
  );
}

/** The records of the registry at the registry addresses of deposit addresses. */
export type LeaseRead = {
  /** By address. */
  records: Map<string, LeaseRecord[]>;
  /** Whether a majority of the relays answered: else the read is no answer (SPEC.md §13). */
  answered: boolean;
  /** Whether a majority of the relays read them completely (SPEC.md, "Complete reads"). */
  complete: boolean;
};

/**
 * The records of the registry at the registry addresses of `addresses`, by address: a complete
 * read on the merchant's `relays`, since LEASE_LOOKBACK before `now` (older leases have ended),
 * with a key of this read alone (leases are signed by sales the integration does not know).
 * `answered` says whether a majority answered (else the caller fails with NetworkError, once it
 * looked at what the others sent: SPEC.md, "Leasing an address", step 3.3); `complete` whether a
 * majority read them completely. Each relay's first copy of an event counts, its signature tried
 * with the other relays' (leaseRecordOf).
 */
export async function readLeases(
  pool: RelayPool,
  registryKey: Uint8Array,
  addresses: readonly string[],
  relays: readonly string[],
  options: {
    now: number;
    random: RandomBytes;
    signal?: AbortSignal | undefined;
    everyRelay?: boolean;
  }
): Promise<LeaseRead> {
  const byD = new Map(addresses.map((address) => [leaseAddress(registryKey, address), address]));
  const found = new Map<string, LeaseRecord[]>(addresses.map((address) => [address, []]));
  if (addresses.length === 0) return { records: found, answered: true, complete: true };
  const { answers, answered, complete } = await pool.queryComplete(
    relays,
    { kinds: [RECORD_KIND], "#d": [...byD.keys()], since: options.now - LEASE_LOOKBACK_SECONDS },
    options.random(32),
    {
      everyRelay: options.everyRelay ?? false,
      // At a lease's address, by any author: the record each event opens to, as it comes (its id
      // checked; a content of a newer NIP-44 version is no record here: anybody writes one).
      keep: (value) => {
        const d = dTag(value);
        return d !== null && byD.has(d)
          ? (openLeaseRecord(value, registryKey, d) ?? undefined)
          : undefined;
      }
    }
  );
  if (options.signal?.aborted) throw options.signal.reason;
  // Ids that checked out: another copy of one is the same event, its signature one more to try.
  const checked = new Map<string, LeaseRecord>();
  for (const records of answers.values()) {
    // A relay's first copy of each id: at most one signature per relay to try.
    const ofRelay = new Set<string>();
    for (const record of records as LeaseRecord[]) {
      const { id } = record.event;
      if (ofRelay.has(id)) continue;
      ofRelay.add(id);
      const known = checked.get(id);
      if (known) {
        known.addCopy(record.event.sig);
        continue;
      }
      checked.set(id, record);
      found.get(byD.get(record.d)!)!.push(record);
    }
  }
  return { records: found, answered, complete };
}

/**
 * Whether the lease `own` of `address` is confirmed by `read`, the read of the address's leases on
 * every relay once `own` was published (SPEC.md, "Leasing an address", step 3.3): a majority of
 * the relays answered and read them completely, and they confirm it at `t` (isConfirmed). A read
 * that cannot be complete never confirms a lease.
 */
export function leaseConfirmed(
  read: LeaseRead,
  address: string,
  own: LeaseEvent,
  t: number
): boolean {
  return read.answered && read.complete && isConfirmed(read.records.get(address) ?? [], own, t);
}

/** A lease of the sale, opened by the sale (or the merchant): its terms. */
export type OpenedLease = {
  event: NostrEvent;
  /** The `d` tag: the registry address of `terms.address`. */
  d: string;
  terms: LeaseTerms;
  /** The lease's JSON, inside, as it was sealed. */
  inside: Record<string, unknown>;
};

function parsePrice(value: unknown): DeclaredPrice | null {
  if (!isObject(value)) return null;
  const { minor, digits, currency } = value;
  if (typeof minor !== "number" || !Number.isSafeInteger(minor) || minor < 0) return null;
  if (
    typeof digits !== "number" ||
    !Number.isInteger(digits) ||
    digits < 0 ||
    digits > MAX_DECLARED_DIGITS
  ) {
    return null;
  }
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  return { minor, digits, currency };
}

/**
 * The inside of a lease's outside, opened with the sale's inner key (SPEC.md, "Opening it as the
 * sale"): its terms, null when they are not valid (its tolerance read as 0 when it is absent or not
 * one). Throws NewerRecordError for a newer version.
 */
export function openLeaseInside(
  outside: Extract<LeaseOutside, { kind: "lease" }>,
  d: string,
  sale: Sale
): { terms: LeaseTerms; inside: Record<string, unknown> } | null {
  let inside: unknown;
  try {
    inside = readJson(nip44Decrypt(outside.sealed, sale.innerKey));
  } catch {
    return null;
  }
  if (!isObject(inside)) return null;
  const v = inside;
  if (typeof v.version === "number" && v.version > LEASE_VERSION) throw new NewerRecordError();
  if (v.version !== LEASE_VERSION) return null;
  const { address, sats, invoice, verifyUrl, createdAt, expiresAt } = v;
  if (!isDepositAddress(address) || leaseAddress(sale.registry.key, address) !== d) return null;
  if (typeof sats !== "number" || !Number.isSafeInteger(sats) || sats < 1) return null;
  if (BigInt(sats) > MAX_SATS) return null;
  if (
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    createdAt >= expiresAt ||
    outside.end !== expiresAt + GRACE_SECONDS
  ) {
    return null;
  }
  if (invoice === null) {
    if (verifyUrl !== null) return null;
  } else {
    if (typeof invoice !== "string" || typeof verifyUrl !== "string" || !parseHttpsUrl(verifyUrl)) {
      return null;
    }
    const decoded = decodeBolt11(invoice);
    if (
      !decoded ||
      decoded.network !== "bc" ||
      decoded.amountMsat !== BigInt(sats) * 1000n ||
      decoded.timestamp !== createdAt ||
      decoded.timestamp + decoded.expirySeconds !== expiresAt
    ) {
      return null;
    }
  }
  const saleValue = v.sale;
  if (!isObject(saleValue)) return null;
  if (saleValue.key !== bytesToHex(sale.key) || typeof saleValue.note !== "string") return null;
  const price = parsePrice(saleValue.fiat);
  if (!price) return null;
  return {
    terms: {
      address,
      sats: BigInt(sats),
      invoice,
      verifyUrl: verifyUrl,
      createdAt,
      expiresAt,
      price,
      note: saleValue.note,
      // Absent (a lease without tolerance) or invalid: none.
      tolerance: toleranceOf(v.tolerance),
      // Absent, or anything but true: not confirmed.
      ...("confirmed" in v ? { confirmed: v.confirmed === true } : {})
    },
    inside: v
  };
}

/**
 * A record of the sale at `d`, opened as a sealed record of its own author (SPEC.md, "Sealed
 * records"): every check, its signature and a content of a newer NIP-44 version (of a newer
 * format) included.
 */
function openSaleRecord(value: unknown, sale: Sale, d: string) {
  const opened = openRecord(value, {
    type: LEASE_RECORD_TYPE,
    encryptionKey: outerKey(sale.registry.key, d, sale.author),
    address: d,
    author: sale.author,
    parse: (outside) => parseOutside(outside)
  });
  if (!opened) return null;
  return {
    event: opened.event,
    outside: opened.status === "newer" ? ({ kind: "newer" } as const) : opened.value
  };
}

/**
 * A record of the sale at a registry address: its lease, its withdrawal, or one of a newer format
 * (authentic, unreadable: the newest at its address, it leaves no lease there).
 */
export type SaleLeaseRecord =
  | { kind: "lease"; lease: OpenedLease }
  | { kind: "withdrawn"; event: NostrEvent; d: string }
  | { kind: "newer"; event: NostrEvent; d: string };

/**
 * What a relay sent, if it is a lease (or a withdrawal) of `sale`: at a registry address (its `d`
 * tag, hex32), signed by the sale, with valid terms inside. Null otherwise; throws
 * NewerRecordError for one of a newer format.
 */
export function openSaleLease(value: unknown, sale: Sale): SaleLeaseRecord | null {
  const d = dTag(value);
  if (d === null || !isObject(value) || value.pubkey !== sale.author) return null;
  const record = openSaleRecord(value, sale, d);
  if (!record) return null;
  const { event, outside } = record;
  if (outside.kind === "newer") throw new NewerRecordError();
  if (outside.kind === "withdrawn") return { kind: "withdrawn", event, d };
  const opened = openLeaseInside(outside, d, sale);
  return opened && { kind: "lease", lease: { event, d, ...opened } };
}
