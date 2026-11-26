import type { OpenedDeclaration } from "../declaration.js";
import { acceptanceRecordAddress, restRecordAddress, type restKeys } from "../derive.js";
import { NetworkError } from "../errors.js";
import { decodeBolt11 } from "../lightning/bolt11.js";
import type { NostrEvent } from "../nostr/event.js";
import {
  NewerRecordError,
  dTagOf,
  openRecord,
  recordsThatOpen,
  sealRecord
} from "../nostr/record.js";
import { majority, type RelayPool } from "../nostr/relay.js";
import {
  CHECKOUT_LIFE_SECONDS,
  CLOCK_TOLERANCE_SECONDS,
  MIN_REST_SECONDS,
  ONCHAIN_FLOOR_SATS,
  RECORD_KIND,
  REST_RECORD_TYPE,
  REST_VERSION
} from "../protocol.js";
import type { RandomBytes } from "../random.js";
import { isObject } from "../text.js";
import { parseHttpsUrl } from "../urls.js";
import type { Rest } from "../types.js";

import { paymentUri } from "./address.js";

/*
 * The rest of an on-chain underpayment (SPEC.md, "The rest of an underpayment"): when less than
 * the amount came on-chain in time, a payment check asks the merchant's Lightning address for an
 * invoice of the rest, declares it for the order's sale with `rest` (the address), and publishes a
 * rest record, which the pages of the order's checkout links read (they cannot read the registry).
 * From ONCHAIN_FLOOR_SATS, the rest is payable on-chain to the same address too; below, in
 * Lightning only.
 */

/** The keys of an invoice's rest records (derive.ts, restKeys). */
export type RestKeys = ReturnType<typeof restKeys>;

/** A rest invoice: a declaration of the sale with `rest`, its invoice decoded. */
export type RestInvoice = {
  bolt11: string;
  paymentHash: string;
  verifyUrl: string;
  sats: bigint;
  /** Its BOLT11 timestamp, and that + its expiry (Unix seconds). */
  createdAt: number;
  expiresAt: number;
};

/** A rest invoice of a declaration with `rest` (opened: its invoice decodes, in whole sats). */
export function restInvoiceOf(declaration: OpenedDeclaration): RestInvoice {
  const { decoded } = declaration;
  return {
    bolt11: declaration.invoice,
    paymentHash: decoded.paymentHash,
    verifyUrl: declaration.verifyUrl,
    sats: decoded.amountMsat! / 1000n,
    createdAt: decoded.timestamp,
    expiresAt: decoded.timestamp + decoded.expirySeconds
  };
}

/** The order of the rest invoices: by date, then payment hash. */
export function byRestOrder(a: RestInvoice, b: RestInvoice): number {
  return (
    a.createdAt - b.createdAt ||
    (a.paymentHash < b.paymentHash ? -1 : a.paymentHash > b.paymentHash ? 1 : 0)
  );
}

/**
 * The `rest` of an open status (SPEC.md, "The status's rest"): null unless `received` is above 0
 * before the invoice's end; else what is left, the latest rest invoice of exactly that amount
 * neither paid nor ended (`paid`: the payment hashes paid), and its QR code: on-chain to `address`
 * too from ONCHAIN_FLOOR_SATS, in Lightning only below.
 */
export function restOf(input: {
  sats: bigint;
  expiresAt: number;
  address: string;
  received: bigint;
  now: number;
  rests: readonly RestInvoice[];
  paid: ReadonlySet<string>;
}): Rest | null {
  const { sats, address, received, now } = input;
  if (received <= 0n || received >= sats || now >= input.expiresAt) return null;
  const rest = sats - received;
  const invoice =
    [...input.rests]
      .sort(byRestOrder)
      .reverse()
      .find(
        (candidate) =>
          candidate.sats === rest &&
          !input.paid.has(candidate.paymentHash) &&
          now < candidate.expiresAt
      ) ?? null;
  const bolt11 = invoice?.bolt11 ?? null;
  return {
    sats: rest.toString(),
    bolt11,
    paymentUri:
      rest >= ONCHAIN_FLOOR_SATS
        ? paymentUri(address, rest, bolt11)
        : bolt11 === null
          ? null
          : `lightning:${bolt11}`
  };
}

/** What a check asks for: an invoice of `sats`, lasting `expirySeconds`. */
export type RestAsk = { sats: bigint; expirySeconds: number };

/**
 * Whether a check whose status gave `rest` asks for an invoice of it (SPEC.md, "Asking for a rest
 * invoice"), and which: none when it has one, with less than MIN_REST_SECONDS left, or when the
 * sale's lease of the address is not the invoice's (`lease`: its sats and end, null without one).
 * The Lightning address's sendable sats are checked after (`sendable`): its pay request is asked
 * only then.
 */
export function restToAsk(input: {
  rest: Rest | null;
  sats: bigint;
  expiresAt: number;
  now: number;
  lease: { sats: bigint; expiresAt: number } | null;
}): RestAsk | null {
  const { rest, now, lease } = input;
  if (rest === null || rest.bolt11 !== null) return null;
  if (now + MIN_REST_SECONDS > input.expiresAt) return null;
  if (lease === null || lease.sats !== input.sats || lease.expiresAt !== input.expiresAt) {
    return null;
  }
  return { sats: BigInt(rest.sats), expirySeconds: input.expiresAt - now };
}

/** Whether `sats` is within the Lightning address's sendable sats. */
export function sendable(sats: bigint, bounds: { min: bigint; max: bigint }): boolean {
  return sats >= bounds.min && sats <= bounds.max;
}

/**
 * The rest record of `invoice` (SPEC.md, "Rest records"): its invoice and verify URL, sealed with
 * the rest encryption key at the rest record address of its payment hash, signed by the rest
 * secret at `createdAt`, dropped by the relays a week after the end of the order's invoice
 * (`expiresAt`), as its checkout links.
 */
export function restRecordEvent(input: {
  keys: RestKeys;
  invoice: Pick<RestInvoice, "bolt11" | "verifyUrl" | "paymentHash">;
  expiresAt: number;
  createdAt: number;
  random?: RandomBytes | undefined;
}): NostrEvent {
  const { keys, invoice } = input;
  return sealRecord({
    type: REST_RECORD_TYPE,
    value: { version: REST_VERSION, invoice: invoice.bolt11, verifyUrl: invoice.verifyUrl },
    signer: keys.secretKey,
    encryptionKey: keys.encryptionKey,
    address: restRecordAddress(keys.key, invoice.paymentHash),
    createdAt: input.createdAt,
    tags: [["expiration", String(input.expiresAt + CHECKOUT_LIFE_SECONDS)]],
    ...(input.random ? { random: input.random } : {})
  });
}

/** The invoice of the order a rest record belongs to: its amount and dates, as its link holds them. */
export type RestLinkTerms = { sats: bigint; createdAt: number; expiresAt: number };

/** A rest record, opened as the page reads it: its invoice, decoded. */
export type OpenedRest = { invoice: RestInvoice; event: NostrEvent };

/**
 * What a relay sent, if it is a rest record of the rest author and rest key of a checkout link of
 * an invoice `terms` describes (SPEC.md, "Reading a rest record"): null when it is not one;
 * `"newer"` for one of a newer format, which the page leaves aside. An event at the link's
 * acceptance record address (same author, which the read of rest records also returns) is no rest
 * record, of a newer format or not.
 */
export function openRestRecord(
  value: unknown,
  keys: Pick<RestKeys, "key" | "author" | "encryptionKey">,
  terms: RestLinkTerms
): OpenedRest | "newer" | null {
  const d = dTagOf(value);
  if (d === null || d === acceptanceRecordAddress(keys.key)) return null;
  const opened = openRecord(value, {
    type: REST_RECORD_TYPE,
    encryptionKey: keys.encryptionKey,
    address: d,
    author: keys.author,
    parse: (v): RestInvoice | null => {
      if (!isObject(v)) return null;
      if (typeof v.version === "number" && v.version > REST_VERSION) {
        throw new NewerRecordError();
      }
      if (v.version !== REST_VERSION || typeof v.invoice !== "string") return null;
      if (typeof v.verifyUrl !== "string" || !parseHttpsUrl(v.verifyUrl)) return null;
      const decoded = decodeBolt11(v.invoice);
      if (!decoded || decoded.network !== "bc" || decoded.amountMsat === null) return null;
      if (decoded.amountMsat <= 0n || decoded.amountMsat % 1000n !== 0n) return null;
      const sats = decoded.amountMsat / 1000n;
      const end = decoded.timestamp + decoded.expirySeconds;
      if (
        sats >= terms.sats ||
        decoded.timestamp < terms.createdAt - CLOCK_TOLERANCE_SECONDS ||
        end > terms.expiresAt + CLOCK_TOLERANCE_SECONDS
      ) {
        return null;
      }
      if (d !== restRecordAddress(keys.key, decoded.paymentHash)) return null;
      return {
        bolt11: v.invoice,
        paymentHash: decoded.paymentHash,
        verifyUrl: v.verifyUrl,
        sats,
        createdAt: decoded.timestamp,
        expiresAt: end
      };
    }
  });
  if (!opened) return null;
  return opened.status === "newer" ? "newer" : { invoice: opened.value, event: opened.event };
}

/**
 * The payment hashes of the rest records of `keys` that a majority of the merchant's `relays` sent
 * (a page reading a majority meets each of them), as the page would read them, and the `d` tags of
 * those of a newer format any relay sent (their invoice is told by the address: never written
 * over, SPEC.md §12); null when fewer than a majority answered. Read with a key of this read alone,
 * not paged (a rest record per rest invoice: a few).
 */
export async function readRestRecords(
  pool: RelayPool,
  keys: RestKeys,
  terms: RestLinkTerms,
  relays: readonly string[],
  options: { random: RandomBytes; signal?: AbortSignal | undefined }
): Promise<{ held: Set<string>; newer: Set<string> } | null> {
  const { answers, answered } = await pool.queryRelays(
    relays,
    { kinds: [RECORD_KIND], authors: [keys.author] },
    options.random(32),
    {
      paged: false,
      keep: recordsThatOpen((_, author) => (author === keys.author ? keys.encryptionKey : null))
    }
  );
  if (options.signal?.aborted) throw options.signal.reason;
  if (!answered) return null;
  const needed = majority(relays.length);
  /** How many relays sent a valid record of each payment hash. */
  const sentBy = new Map<string, number>();
  const newer = new Set<string>();
  for (const events of answers.values()) {
    const hashes = new Set<string>();
    for (const value of events) {
      const opened = openRestRecord(value, keys, terms);
      if (opened === "newer") newer.add(dTagOf(value)!);
      else if (opened !== null) hashes.add(opened.invoice.paymentHash);
    }
    for (const hash of hashes) sentBy.set(hash, (sentBy.get(hash) ?? 0) + 1);
  }
  const held = new Set([...sentBy].filter(([, count]) => count >= needed).map(([hash]) => hash));
  return { held, newer };
}

/**
 * Publishes a rest record on the merchant's `relays`, signed and authenticated with the rest
 * secret: resolves once a majority took it, else throws NetworkError.
 */
export async function publishRestRecord(
  pool: RelayPool,
  event: NostrEvent,
  keys: RestKeys,
  relays: readonly string[],
  signal?: AbortSignal
): Promise<void> {
  try {
    await pool.publishToQuorum(relays, event, keys.secretKey, majority(relays.length));
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new NetworkError(
      "Fewer than a majority of the merchant's relays took the record of an invoice of the rest",
      { cause: error }
    );
  }
}
