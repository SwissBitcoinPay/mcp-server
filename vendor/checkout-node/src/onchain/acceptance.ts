import { acceptanceRecordAddress } from "../derive.js";
import { NetworkError } from "../errors.js";
import type { NostrEvent } from "../nostr/event.js";
import {
  NewerRecordError,
  dTagOf,
  newestRecord,
  openRecord,
  recordsThatOpen,
  sealRecord,
  type OpenedRecord
} from "../nostr/record.js";
import { majority, type RelayPool } from "../nostr/relay.js";
import {
  ACCEPTANCE_RECORD_TYPE,
  ACCEPTANCE_VERSION,
  CHECKOUT_LIFE_SECONDS,
  RECORD_KIND
} from "../protocol.js";
import type { RandomBytes } from "../random.js";
import { isObject } from "../text.js";
import type { Logger, PaymentStatus } from "../types.js";

import type { RestKeys } from "./rest.js";

/*
 * Acceptance records (SPEC.md, "Acceptance records"): the page of a checkout link cannot know the
 * merchant's tolerance nor read the merchant's acceptance (merchant-acceptance.ts), so an order
 * either accepted would read underpaid there, its customer asked for the rest and never sent back
 * to the shop. A check whose status is paid (or being confirmed) with less than the amount
 * publishes what it received then, signed by the rest secret, for the pages of the order's
 * checkout links: they count the payment as enough from that on. Never the tolerance itself.
 */

/**
 * What a check whose status is `status` must have the pages of the order's checkout links know
 * (SPEC.md, "Publishing it"): the status's `received`, when the order's tolerance or the
 * merchant's acceptance accepted less than its amount (`unconfirmed`, or `paid` with
 * transactions) before the links' life ends; null otherwise.
 */
export function acceptanceToPublish(
  status: PaymentStatus,
  invoice: { sats: bigint; expiresAt: number },
  now: number
): bigint | null {
  if (now >= invoice.expiresAt + CHECKOUT_LIFE_SECONDS) return null;
  const accepted =
    status.state === "unconfirmed" ||
    (status.state === "paid" && status.method !== "lightning" && status.txids.length > 0);
  if (!accepted) return null;
  const received = BigInt(status.received);
  return received < invoice.sats ? received : null;
}

/**
 * The acceptance record of the invoice of `keys` (its rest keys): `received`, sealed with the rest
 * encryption key at its acceptance record address, signed by the rest secret at `createdAt`,
 * dropped by the relays a week after the invoice's end (`expiresAt`), as its checkout links.
 */
export function acceptanceRecordEvent(input: {
  keys: RestKeys;
  received: bigint;
  expiresAt: number;
  createdAt: number;
  random?: RandomBytes | undefined;
}): NostrEvent {
  const { keys } = input;
  return sealRecord({
    type: ACCEPTANCE_RECORD_TYPE,
    value: { version: ACCEPTANCE_VERSION, received: Number(input.received) },
    signer: keys.secretKey,
    encryptionKey: keys.encryptionKey,
    address: acceptanceRecordAddress(keys.key),
    createdAt: input.createdAt,
    tags: [["expiration", String(input.expiresAt + CHECKOUT_LIFE_SECONDS)]],
    ...(input.random ? { random: input.random } : {})
  });
}

/** An acceptance record, opened as the page reads it. */
export type OpenedAcceptance = { received: bigint; event: NostrEvent };

/** `value` opened as an acceptance record of `keys` for an invoice of `sats`, else null. */
function openAcceptance(
  value: unknown,
  keys: Pick<RestKeys, "key" | "author" | "encryptionKey">,
  sats: bigint
): OpenedRecord<bigint> | null {
  const address = acceptanceRecordAddress(keys.key);
  if (dTagOf(value) !== address) return null;
  return openRecord(value, {
    type: ACCEPTANCE_RECORD_TYPE,
    encryptionKey: keys.encryptionKey,
    address,
    author: keys.author,
    parse: (v): bigint | null => {
      if (!isObject(v)) return null;
      if (typeof v.version === "number" && v.version > ACCEPTANCE_VERSION) {
        throw new NewerRecordError();
      }
      if (v.version !== ACCEPTANCE_VERSION) return null;
      const { received } = v;
      if (typeof received !== "number" || !Number.isSafeInteger(received) || received < 1) {
        return null;
      }
      return BigInt(received) < sats ? BigInt(received) : null;
    }
  });
}

/**
 * What a relay sent, if it is an acceptance record of the rest author and rest key of a checkout
 * link of an invoice of `sats` (SPEC.md, "Reading an acceptance record"): its `received`, from 1,
 * below `sats`; null when it is not one; `"newer"` for one of a newer format, left aside.
 */
export function openAcceptanceRecord(
  value: unknown,
  keys: Pick<RestKeys, "key" | "author" | "encryptionKey">,
  sats: bigint
): OpenedAcceptance | "newer" | null {
  const opened = openAcceptance(value, keys, sats);
  if (!opened) return null;
  return opened.status === "newer" ? "newer" : { received: opened.value, event: opened.event };
}

/**
 * Whether the pages already know `received` (SPEC.md, "Publishing it"): a majority of the
 * merchant's `relays` each sent a valid acceptance record of the invoice of `keys` (of `sats`)
 * whose `received`, the newest it sent, is at most `received`. Read with a key of this read alone,
 * not paged (one record per invoice). True when a relay sent one of a newer format, never written
 * over (SPEC.md, "Sealed records"): logged, so that the package is updated. NetworkError when fewer
 * than a majority answered: what the others hold cannot be told, so nothing is published.
 */
export async function acceptanceKnown(
  pool: RelayPool,
  keys: RestKeys,
  sats: bigint,
  received: bigint,
  relays: readonly string[],
  options: { random: RandomBytes; signal?: AbortSignal | undefined; logger: Logger }
): Promise<boolean> {
  const needed = majority(relays.length);
  const { answers, answered } = await pool.queryRelays(
    relays,
    { kinds: [RECORD_KIND], authors: [keys.author], "#d": [acceptanceRecordAddress(keys.key)] },
    options.random(32),
    {
      paged: false,
      keep: recordsThatOpen((_, author) => (author === keys.author ? keys.encryptionKey : null))
    }
  );
  if (options.signal?.aborted) throw options.signal.reason;
  let holders = 0;
  for (const [relay, events] of answers) {
    const { newest, newestUnreadable } = newestRecord(new Map([[relay, events]]), (value) =>
      openAcceptance(value, keys, sats)
    );
    if (newestUnreadable !== null) {
      options.logger.warn(
        "@sattleme/checkout: an acceptance record of this order has a newer format than this " +
          "version of @sattleme/checkout: update it"
      );
      return true;
    }
    if (newest !== null && newest.value <= received) holders += 1;
  }
  // Fewer than a majority answered: what the others hold (of a newer format, perhaps) cannot be
  // told, so nothing is written over it; the next check reads again (SPEC.md §13, §12).
  if (!answered) {
    throw new NetworkError("Fewer than a majority of the merchant's relays answered");
  }
  return holders >= needed;
}

/**
 * Lets the pages of the order's checkout links know what its tolerance or the merchant's
 * acceptance accepted (SPEC.md, "Acceptance records"), from `status`, the status a check gave of
 * the invoice (`invoice`: its sats and end): when acceptanceToPublish gives what it received,
 * publishes an acceptance record of it with the rest keys `keys` gives (asked only then), unless a
 * majority of the merchant's `relays` hold one of it or less (acceptanceKnown). Resolves with what it published, or null.
 * Throws NetworkError when fewer than a majority answered the read, or took the record.
 */
export async function publishAcceptance(
  pool: RelayPool,
  status: PaymentStatus,
  invoice: { sats: bigint; expiresAt: number },
  keys: () => RestKeys,
  relays: readonly string[],
  options: {
    clock: () => number;
    random: RandomBytes;
    signal?: AbortSignal | undefined;
    logger: Logger;
  }
): Promise<bigint | null> {
  const received = acceptanceToPublish(status, invoice, options.clock());
  if (received === null) return null;
  const rest = keys();
  if (await acceptanceKnown(pool, rest, invoice.sats, received, relays, options)) return null;
  await publishAcceptanceRecord(
    pool,
    acceptanceRecordEvent({
      keys: rest,
      received,
      expiresAt: invoice.expiresAt,
      createdAt: options.clock(),
      random: options.random
    }),
    rest,
    relays,
    options.signal
  );
  return received;
}

/**
 * Publishes an acceptance record on the merchant's `relays`, signed and authenticated with the rest
 * secret: resolves once a majority took it, else throws NetworkError.
 */
export async function publishAcceptanceRecord(
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
      "Fewer than a majority of the merchant's relays took the acceptance record of a payment",
      { cause: error }
    );
  }
}
