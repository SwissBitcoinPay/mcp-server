import { hexToBytes } from "@noble/hashes/utils.js";

import type { NostrEvent } from "../../vendor/checkout-node/src/nostr/event.js";
import {
  NewerRecordError,
  newestRecord,
  openRecord,
  recordsThatOpen,
  sealRecord,
  type NewestRecord
} from "../../vendor/checkout-node/src/nostr/record.js";
import { majority } from "../../vendor/checkout-node/src/nostr/relay.js";
import { RECORD_KIND } from "../../vendor/checkout-node/src/protocol.js";

import { COUNTER_TYPE, COUNTER_VERSION } from "./constants.js";
import type { Call } from "./context.js";
import { AssistantError } from "./errors.js";
import type { InvoiceNumber } from "./invoice.js";
import { counterKeys, type AssistantKeys } from "./keys.js";
import { isObject } from "./text.js";

/*
 * The merchant's one series of invoice numbers (SPEC.md §6): each writer (the owner's devices, each
 * assistant) keeps a copy of the shared counter, signed by its invoices author, at one address. A
 * number is taken over every writer's copy, then this assistant's copy is saved with it on a
 * majority of the relays before the number is used, as the merchant's app does
 * (src/lib/invoice/counter.ts, takeSharedInvoiceNumber).
 */

export type Counter = { version: typeof COUNTER_VERSION; year: number; last: number };

export function parseCounter(value: unknown): Counter | null {
  if (!isObject(value)) return null;
  const v = value;
  if (typeof v.version === "number" && v.version > COUNTER_VERSION) throw new NewerRecordError();
  if (v.version !== COUNTER_VERSION) return null;
  const { year, last } = v;
  if (!Number.isSafeInteger(year) || (year as number) < 2000 || (year as number) > 9999) {
    return null;
  }
  if (!Number.isSafeInteger(last) || (last as number) < 1) return null;
  return { version: COUNTER_VERSION, year: year as number, last: last as number };
}

/** The number after every counter of `counters` in `year`, and above every number of `floor`. */
export function nextNumberOf(
  counters: readonly Counter[],
  year: number,
  floor: readonly InvoiceNumber[] = []
): InvoiceNumber {
  const counted = counters.reduce(
    (highest, counter) => (counter.year === year ? Math.max(highest, counter.last) : highest),
    0
  );
  const saved = floor.reduce(
    (highest, number) => (number.year === year ? Math.max(highest, number.sequence) : highest),
    0
  );
  return { year, sequence: Math.max(counted, saved) + 1 };
}

/** This assistant's copy of the shared counter. */
export function counterEvent(
  keys: AssistantKeys,
  counterKey: string,
  counter: Counter,
  createdAt: number,
  call: Pick<Call, "random">
): NostrEvent {
  const shared = counterKeys(hexToBytes(counterKey));
  return sealRecord({
    type: COUNTER_TYPE,
    value: counter,
    signer: keys.invoices.nostr.secretKey,
    encryptionKey: shared.encryptionKey,
    address: shared.address,
    createdAt,
    random: call.random
  });
}

function isNewer<T>(read: NewestRecord<T>): boolean {
  return (
    read.newestUnreadable !== null && read.newestUnreadable >= (read.newest?.event.created_at ?? 0)
  );
}

/**
 * Takes the next number of `year` in the merchant's series (SPEC.md §6): every writer's copy read
 * on a majority of `relays`, the number after the highest (and above `floor`), then this assistant's
 * copy saved with it on a majority, dated after its own copy read. Throws AssistantError `number`
 * when fewer than a majority answered or took it, or when a copy is of a newer format: no number
 * is given then.
 */
export async function takeNumber(
  call: Call,
  keys: AssistantKeys,
  {
    counterKey,
    writers,
    relays
  }: { counterKey: string; writers: readonly string[]; relays: readonly string[] },
  year: number,
  floor: readonly InvoiceNumber[] = []
): Promise<InvoiceNumber> {
  const shared = counterKeys(hexToBytes(counterKey));
  const self = keys.invoices.nostr.publicKey;
  const authors = [self, ...new Set(writers)].filter(
    (author, index, all) => all.indexOf(author) === index
  );
  const { answers, answered } = await call.pool.queryRelays(
    relays,
    { kinds: [RECORD_KIND], authors, "#d": [shared.address] },
    keys.invoices.nostr.secretKey,
    {
      paged: false,
      keep: recordsThatOpen((d, author) =>
        d === shared.address && authors.includes(author) ? shared.encryptionKey : null
      )
    }
  );
  if (!answered) {
    throw new AssistantError("number", "Fewer than a majority of the relays gave the counter");
  }
  const copies = authors.map((author) =>
    newestRecord(answers, (value) =>
      openRecord(value, {
        type: COUNTER_TYPE,
        encryptionKey: shared.encryptionKey,
        address: shared.address,
        author,
        parse: parseCounter
      })
    )
  );
  if (copies.some(isNewer)) {
    throw new AssistantError("number", "A counter has a newer format: update this server");
  }
  const number = nextNumberOf(
    copies.flatMap(({ newest }) => (newest ? [newest.value] : [])),
    year,
    floor
  );
  const own = copies[0]!;
  const createdAt = Math.max(
    call.now(),
    (own.newest?.event.created_at ?? 0) + 1,
    (own.newestUnreadable ?? 0) + 1
  );
  const event = counterEvent(
    keys,
    counterKey,
    { version: COUNTER_VERSION, year: number.year, last: number.sequence },
    createdAt,
    call
  );
  try {
    await call.pool.publishToQuorum(
      relays,
      event,
      keys.invoices.nostr.secretKey,
      majority(relays.length)
    );
  } catch {
    throw new AssistantError("number", "Fewer than a majority of the relays took the counter");
  }
  return number;
}
