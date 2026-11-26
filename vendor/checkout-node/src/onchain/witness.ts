import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { channelKeys, seenKeys } from "../derive.js";
import { NetworkError } from "../errors.js";
import { hasValidId, signatureChecks, type NostrEvent } from "../nostr/event.js";
import {
  NewerRecordError,
  dTagOf,
  openRecord,
  recordsThatOpen,
  replaces,
  sealRecord
} from "../nostr/record.js";
import { majority, type RelayPool } from "../nostr/relay.js";
import {
  MAX_SATS,
  MAX_WITNESS_INPUTS,
  NO_SALE,
  ORDER_TAG,
  RECORD_KIND,
  WITNESS_RECORD_TYPE,
  WITNESS_VERSION
} from "../protocol.js";
import type { RandomBytes } from "../random.js";
import { isHex32, isObject } from "../text.js";

import { isDepositAddress } from "./address.js";

/*
 * Witnesses (SPEC.md, "Witnesses"): the integration records each transaction it sees paying an
 * address of its lot, and when: during the lease of an order (that order's sale), or at no lease's
 * time (`none`). So that every reader, the merchant's app included, tells the same order paid. Only
 * the integration writes them (signed by its seen secret, sealed with its channel's key); the
 * merchant's app reads them to attribute deposits and to take paid addresses out of the lot.
 */

/** The keys of the integration's witnesses. Secrets: never logged. */
export type SeenKeys = {
  secretKey: Uint8Array;
  /** Hex: the author of every witness. */
  author: string;
  addressKey: Uint8Array;
  /** The channel's encryption key: the witnesses' NIP-44 conversation key. */
  encryptionKey: Uint8Array;
};

export function seenOf(integrationKey: Uint8Array): SeenKeys {
  return { ...seenKeys(integrationKey), encryptionKey: channelKeys(integrationKey).encryptionKey };
}

function mac(key: Uint8Array, text: string): string {
  return bytesToHex(hmac(sha256, key, utf8ToBytes(text)));
}

/** Where the witness of `txid` paying `address` for `sale` (a sale author, or null: none) is. */
export function witnessAddress(
  addressKey: Uint8Array,
  address: string,
  txid: string,
  sale: string | null
): string {
  return mac(addressKey, `${address}/${txid}/${sale ?? NO_SALE}`);
}

/** The `o` tag of the witnesses of `address` for `sale` (null: none): how a check reads them. */
export function orderTag(addressKey: Uint8Array, address: string, sale: string | null): string {
  return mac(addressKey, `order/${address}/${sale ?? NO_SALE}`);
}

/**
 * The address tag of `address`: a witness's second `o` tag, which finds every witness of the
 * address, whatever its sale (SPEC.md, "Witnesses").
 */
export function addressTag(addressKey: Uint8Array, address: string): string {
  return mac(addressKey, `address/${address}`);
}

/** A coin, as a witness writes it: `<txid>:<vout>`, the vout a u32 in decimal without leading zeros. */
export function isCoin(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{64}:(?:0|[1-9][0-9]{0,9})$/.test(value) &&
    Number(value.slice(65)) <= 4_294_967_295
  );
}

/** What a witness says. */
export type Witness = {
  address: string;
  txid: string;
  /** The sale author (hex), or null: at no lease's time. */
  sale: string | null;
  /** What `txid` pays `address`. */
  sats: bigint;
  /** The coins `txid` spends, its first 100, in their order. */
  inputs: string[];
  /** Held for the sale only as a replacement of payments in time: `txid` came after the lease. */
  replacement: boolean;
  /** The `expiresAt` of the invoice whose lease `txid` came in (or stands for); null for none. */
  expiresAt: number | null;
};

/** The signed event of a witness, `created_at` when it was seen. */
export function witnessEvent(
  seen: SeenKeys,
  witness: Witness,
  createdAt: number,
  random?: RandomBytes
): NostrEvent {
  return sealRecord({
    type: WITNESS_RECORD_TYPE,
    value: {
      version: WITNESS_VERSION,
      address: witness.address,
      txid: witness.txid,
      sale: witness.sale,
      sats: Number(witness.sats),
      inputs: witness.inputs.slice(0, MAX_WITNESS_INPUTS),
      replacement: witness.replacement,
      expiresAt: witness.sale === null ? null : witness.expiresAt
    },
    signer: seen.secretKey,
    encryptionKey: seen.encryptionKey,
    address: witnessAddress(seen.addressKey, witness.address, witness.txid, witness.sale),
    createdAt,
    tags: [
      [ORDER_TAG, orderTag(seen.addressKey, witness.address, witness.sale)],
      [ORDER_TAG, addressTag(seen.addressKey, witness.address)]
    ],
    ...(random ? { random } : {})
  });
}

/**
 * A witness's value, checked against its event's tags: its `d` tag is the witness address of what
 * it names, an `o` tag its order tag and an `o` tag its address's tag. Null when it is not valid;
 * throws NewerRecordError for a newer version.
 */
function parseWitness(value: unknown, event: NostrEvent, addressKey: Uint8Array): Witness | null {
  if (!isObject(value)) return null;
  const v = value;
  if (typeof v.version === "number" && v.version > WITNESS_VERSION) throw new NewerRecordError();
  if (v.version !== WITNESS_VERSION) return null;
  const { address, txid, sale, sats, inputs, replacement } = v;
  if (!isDepositAddress(address) || !isHex32(txid)) return null;
  if (sale !== null && !isHex32(sale)) return null;
  if (typeof sats !== "number" || !Number.isSafeInteger(sats) || sats < 1) return null;
  if (BigInt(sats) > MAX_SATS) return null;
  if (
    !Array.isArray(inputs) ||
    inputs.length > MAX_WITNESS_INPUTS ||
    !inputs.every(isCoin) ||
    new Set(inputs).size !== inputs.length
  ) {
    return null;
  }
  if (typeof replacement !== "boolean" || (sale === null && replacement)) return null;
  // Null for none, the invoice's end for a sale; absent, it is no witness.
  const { expiresAt } = v;
  if (
    sale === null
      ? expiresAt !== null
      : typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt)
  ) {
    return null;
  }
  const d = event.tags.find(([name]) => name === "d")?.[1];
  const hasTag = (tag: string) =>
    event.tags.some(([name, content]) => name === ORDER_TAG && content === tag);
  if (
    d !== witnessAddress(addressKey, address, txid, sale) ||
    !hasTag(orderTag(addressKey, address, sale)) ||
    !hasTag(addressTag(addressKey, address))
  ) {
    return null;
  }
  return {
    address,
    txid,
    sale,
    sats: BigInt(sats),
    inputs: inputs,
    replacement,
    expiresAt: expiresAt as number | null
  };
}

/** A witness a relay sent, opened. */
export type OpenedWitness =
  | { status: "ok"; event: NostrEvent; witness: Witness }
  /** Authentic, but of a newer format: what it names cannot be read, its `d` tag can. */
  | { status: "newer"; event: NostrEvent; d: string };

/** What a relay sent, if it is a witness of this integration; null otherwise. */
export function openWitness(value: unknown, seen: SeenKeys): OpenedWitness | null {
  const d = dTagOf(value);
  if (d === null) return null;
  const opened = openRecord(value, {
    type: WITNESS_RECORD_TYPE,
    encryptionKey: seen.encryptionKey,
    address: d,
    author: seen.author,
    parse: (v, event) => parseWitness(v, event, seen.addressKey)
  });
  if (!opened) return null;
  return opened.status === "newer"
    ? { status: "newer", event: opened.event, d }
    : { status: "ok", event: opened.event, witness: opened.value };
}

/** A witness of the order's sale, as a check uses it. */
export type SaleWitness = {
  sats: bigint;
  inputs: string[];
  replacement: boolean;
  /** Its `created_at`: when it was seen. */
  seenAt: number;
};

/**
 * The witnesses of an invoice: of this invoice (its sale and its `expiresAt`), of other
 * invoices (another sale, or another `expiresAt` of its sale), of none, and of a newer format.
 */
export type OrderWitnesses = {
  /** Of this invoice, by txid. */
  sale: Map<string, SaleWitness>;
  /** Of other invoices, by txid: what they name counts for nothing here. */
  others: Map<string, SaleWitness>;
  /** The txids a witness none names. */
  none: Set<string>;
  /** The witness addresses (`d` tags) of the witnesses of a newer format. */
  newer: Set<string>;
};

/**
 * The witnesses of the invoice with the address `address` and the end `expiresAt`, for the sale
 * `saleAuthor`: read on the merchant's `relays` by their order tags (of the sale and of none) and
 * the address tag (every sale's), as soon as a majority answered, with a key of this read alone
 * (orderWitnessesOf). Throws NetworkError when fewer than a majority answered.
 */
export async function readOrderWitnesses(
  pool: RelayPool,
  seen: SeenKeys,
  address: string,
  saleAuthor: string,
  expiresAt: number,
  relays: readonly string[],
  options: { random: RandomBytes; signal?: AbortSignal | undefined; everyRelay?: boolean }
): Promise<OrderWitnesses> {
  // With everyRelay, on every relay (SPEC.md §13).
  const { answers, answered } = await pool.queryRelays(
    relays,
    { kinds: [RECORD_KIND], authors: [seen.author], "#o": readTags(seen, address, saleAuthor) },
    options.random(32),
    {
      paged: false,
      everyRelay: options.everyRelay ?? false,
      keep: recordsThatOpen((_, author) => (author === seen.author ? seen.encryptionKey : null))
    }
  );
  if (options.signal?.aborted) throw options.signal.reason;
  if (!answered) {
    throw new NetworkError("Fewer than a majority of the merchant's relays answered");
  }
  return orderWitnessesOf([...answers.values()].flat(), seen, address, saleAuthor, expiresAt);
}

/** The `o` tags of the read of an invoice's witnesses: of the sale, of none, of the address. */
function readTags(seen: SeenKeys, address: string, saleAuthor: string): string[] {
  return [
    orderTag(seen.addressKey, address, saleAuthor),
    orderTag(seen.addressKey, address, null),
    addressTag(seen.addressKey, address)
  ];
}

/**
 * The witnesses of the invoice with the address `address` and the end `expiresAt`, for the sale
 * `saleAuthor`, from what the relays sent to its read: of each witness address, the newest event
 * that opens (one of a newer format, its event checked, is kept as such). A witness that holds none
 * of the read's `o` tags, or whose `address` is not `address`, is of no invoice of this read and is
 * ignored, of a newer format or not: only a relay that does not keep to the filter sends one (a
 * transaction may pay the addresses of two orders: the witnesses at each address tell its own).
 */
export function orderWitnessesOf(
  events: Iterable<unknown>,
  seen: SeenKeys,
  address: string,
  saleAuthor: string,
  expiresAt: number
): OrderWitnesses {
  const tags = new Set(readTags(seen, address, saleAuthor));
  const newest = new Map<string, OpenedWitness>();
  const checked = new Set<string>();
  for (const value of events) {
    if (isObject(value) && typeof value.id === "string" && checked.has(value.id)) continue;
    const opened = openWitness(value, seen);
    if (!opened) continue;
    checked.add(opened.event.id);
    if (!opened.event.tags.some(([name, content]) => name === ORDER_TAG && tags.has(content!))) {
      continue;
    }
    if (opened.status === "ok" && opened.witness.address !== address) continue;
    const d = opened.event.tags.find(([name]) => name === "d")![1]!;
    const known = newest.get(d);
    if (!known || replaces(opened.event, known.event)) newest.set(d, opened);
  }
  const witnesses: OrderWitnesses = {
    sale: new Map(),
    others: new Map(),
    none: new Set(),
    newer: new Set()
  };
  for (const [d, opened] of newest) {
    if (opened.status === "newer") {
      witnesses.newer.add(d);
      continue;
    }
    const { witness, event } = opened;
    const of: SaleWitness = {
      sats: witness.sats,
      inputs: witness.inputs,
      replacement: witness.replacement,
      seenAt: event.created_at
    };
    if (witness.sale === null) {
      witnesses.none.add(witness.txid);
    } else if (witness.sale === saleAuthor && witness.expiresAt === expiresAt) {
      witnesses.sale.set(witness.txid, of);
    } else {
      witnesses.others.set(witness.txid, of);
    }
  }
  return witnesses;
}

/**
 * The addresses of `byTag` (address tag → address) an event names (SPEC.md, "Leasing an address",
 * step 3): when it is of `seenAuthor` and checks out (SPEC.md §11), each address whose address tag
 * it holds as an `o` tag, whatever its content (one that does not open as a witness, or of a newer
 * format, included). `checks` verifies its signature once its id was checked.
 */
export function addressesNamed(
  value: unknown,
  seenAuthor: string,
  byTag: ReadonlyMap<string, string>,
  checks: (event: NostrEvent) => boolean = signatureChecks
): string[] {
  if (!isObject(value) || value.pubkey !== seenAuthor || !Array.isArray(value.tags)) return [];
  const tagged = new Set(
    (value.tags as unknown[]).flatMap((tag) =>
      Array.isArray(tag) && tag[0] === ORDER_TAG && byTag.has(tag[1] as string)
        ? [byTag.get(tag[1] as string)!]
        : []
    )
  );
  // The cheap checks first: the signature only of an event that would name an address.
  return tagged.size > 0 && hasValidId(value) && checks(value) ? [...tagged] : [];
}

/**
 * The addresses of `addresses` a witness names (SPEC.md, "Leasing an address", step 2): read on
 * the merchant's `relays` by their address tags, not paged, as soon as a majority answered, with a
 * key of this read alone. An event of the seen author that checks out with an address's tag as an
 * `o` tag names that address, one of a newer format included. Throws NetworkError when fewer than
 * a majority answered.
 */
export async function readNamedAddresses(
  pool: RelayPool,
  seen: SeenKeys,
  addresses: readonly string[],
  relays: readonly string[],
  options: { random: RandomBytes; signal?: AbortSignal | undefined }
): Promise<Set<string>> {
  const named = new Set<string>();
  if (addresses.length === 0) return named;
  const byTag = new Map(
    addresses.map((address) => [addressTag(seen.addressKey, address), address])
  );
  /** Whether each event's signature verifies: once, whatever relays send copies of it. */
  const verdicts = new Map<string, boolean>();
  const checks = (event: NostrEvent) => {
    const copy = `${event.id}/${event.sig}`;
    let valid = verdicts.get(copy);
    if (valid === undefined) verdicts.set(copy, (valid = signatureChecks(event)));
    return valid;
  };
  const { answers, answered } = await pool.queryRelays(
    relays,
    { kinds: [RECORD_KIND], authors: [seen.author], "#o": [...byTag.keys()] },
    options.random(32),
    {
      paged: false,
      // Of each event, the addresses it names: nothing else is kept.
      keep: (value) => {
        const names = addressesNamed(value, seen.author, byTag, checks);
        return names.length > 0 ? names : undefined;
      }
    }
  );
  if (options.signal?.aborted) throw options.signal.reason;
  if (!answered) {
    throw new NetworkError("Fewer than a majority of the merchant's relays answered");
  }
  for (const kept of answers.values()) {
    for (const names of kept) for (const address of names as string[]) named.add(address);
  }
  return named;
}

/**
 * Publishes a witness on the merchant's `relays`, signed and authenticated with the seen secret:
 * resolves once a majority took it, else throws NetworkError.
 */
export async function publishWitness(
  pool: RelayPool,
  seen: SeenKeys,
  witness: Witness,
  relays: readonly string[],
  options: { createdAt: number; random: RandomBytes; signal?: AbortSignal | undefined }
): Promise<void> {
  const event = witnessEvent(seen, witness, options.createdAt, options.random);
  try {
    await pool.publishToQuorum(relays, event, seen.secretKey, majority(relays.length));
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    throw new NetworkError(
      "Fewer than a majority of the merchant's relays took the witness of a payment",
      { cause: error }
    );
  }
}
