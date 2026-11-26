import { channelKeys, merchantAcceptanceAddress } from "../derive.js";
import { NetworkError } from "../errors.js";
import type { NostrEvent } from "../nostr/event.js";
import { NewerRecordError, openRecord, recordsThatOpen, replaces } from "../nostr/record.js";
import { majority, type RelayPool } from "../nostr/relay.js";
import {
  GRACE_SECONDS,
  MERCHANT_ACCEPTANCE_RECORD_TYPE,
  MERCHANT_ACCEPTANCE_VERSION,
  RECORD_KIND
} from "../protocol.js";
import type { RandomBytes } from "../random.js";
import { isObject } from "../text.js";

/*
 * The merchant's acceptance (SPEC.md, "The merchant's acceptance"): the merchant may accept by
 * hand, in its app, what an order underpaid on-chain received as paying it in full. The app
 * publishes a record of the team (the integration key opens it but cannot make one) holding what
 * the order had received then; a check judges the payment against that amount when it is less than
 * the least the order's tolerance accepts (tolerance.ts, dueOnchain). The majority of the
 * merchant's relays holds the truth: a check reads it on every relay and counts a record only when
 * a majority of the relays sent it. A check never publishes one, nor publishes one again: the pages
 * of the order's checkout links learn of it only through an acceptance record (acceptance.ts).
 */

/** What a check opens the merchant's acceptance of an invoice with. */
export type MerchantAcceptanceKeys = {
  /** The team's public key (hex): its only author. */
  team: string;
  /** The channel's encryption key: its NIP-44 conversation key. */
  encryptionKey: Uint8Array;
  /** Its `d` tag (merchantAcceptanceAddress). */
  address: string;
};

/**
 * The keys of the merchant's acceptance of the invoice of the sale `saleAuthor` with the deposit
 * address `address` and the end `expiresAt`, for the integration `integrationKey` of `team`.
 */
export function merchantAcceptanceKeys(
  integrationKey: Uint8Array,
  team: string,
  saleAuthor: string,
  address: string,
  expiresAt: number
): MerchantAcceptanceKeys {
  return {
    team,
    encryptionKey: channelKeys(integrationKey).encryptionKey,
    address: merchantAcceptanceAddress(integrationKey, saleAuthor, address, expiresAt)
  };
}

/** The invoice a merchant's acceptance is read for: its amount and its end. */
export type AcceptedInvoice = { sats: bigint; expiresAt: number };

/** A merchant's acceptance a relay sent, opened (openMerchantAcceptance). */
export type OpenedMerchantAcceptance =
  /** Valid: what the order had received when the merchant accepted it. */
  | { status: "ok"; event: NostrEvent; received: bigint }
  /** Of a newer format: logged; the newest a majority sent, it leaves the order without one. */
  | { status: "newer"; event: NostrEvent }
  /** Of a newer format, dated after the lease's end: set aside as any record dated so, logged. */
  | { status: "newer, set aside"; event: NostrEvent };

/**
 * What a relay sent, read as the merchant's acceptance of `invoice` (SPEC.md, "Reading it"): a
 * record of type `integration-onchain-accepted`, author the team, sealed with the channel's key,
 * at the address of `keys`, that checks out (its id, its signature); valid when its value is an
 * object whose `version` is 1 and whose `received` is a safe integer from 1, below the invoice's
 * `sats` (more fields ignored), of a newer format when its `version` is above 1 or its content of a
 * newer NIP-44 version. Null for anything else, and for a record dated after the lease's end
 * (`expiresAt` + 120), which is set aside whatever its format: one of a newer format is still told,
 * for the warning (`newer, set aside`). Its `created_at` is never compared with now.
 */
export function openMerchantAcceptance(
  value: unknown,
  keys: MerchantAcceptanceKeys,
  invoice: AcceptedInvoice
): OpenedMerchantAcceptance | null {
  const opened = openRecord(value, {
    type: MERCHANT_ACCEPTANCE_RECORD_TYPE,
    encryptionKey: keys.encryptionKey,
    address: keys.address,
    author: keys.team,
    parse: (v): bigint | null => {
      if (!isObject(v)) return null;
      if (typeof v.version === "number" && v.version > MERCHANT_ACCEPTANCE_VERSION) {
        throw new NewerRecordError();
      }
      if (v.version !== MERCHANT_ACCEPTANCE_VERSION) return null;
      const { received } = v;
      if (typeof received !== "number" || !Number.isSafeInteger(received) || received < 1) {
        return null;
      }
      return BigInt(received) < invoice.sats ? BigInt(received) : null;
    }
  });
  if (!opened) return null;
  // After the lease's end: set aside, of a newer format or not (SPEC.md, "Reading it").
  const late = opened.event.created_at > invoice.expiresAt + GRACE_SECONDS;
  if (opened.status === "newer") {
    return { status: late ? "newer, set aside" : "newer", event: opened.event };
  }
  return late ? null : { status: "ok", event: opened.event, received: opened.value };
}

/** The merchant's acceptance of an invoice, as a check counts it. */
export type MerchantAcceptance = {
  /** The `received` of the merchant's acceptance that counts; null without one. */
  received: bigint | null;
  /** Whether a relay sent one of a newer format, whatever its date and how many relays sent it. */
  newer: boolean;
};

/**
 * The merchant's acceptance of `invoice` (SPEC.md, "Counting it"), from what each relay of the
 * merchant's list (`relayCount` relays) sent to its read on every relay (`answers`, by relay):
 * every copy opened (openMerchantAcceptance), once per id and signature; a relay sent a record when
 * it sent a copy of it that opens. Of the records valid or of a newer format that a majority of
 * the list sent, the newest (the highest `created_at`, then the lowest id, as relays keep them)
 * decides: a valid one is the merchant's acceptance, one of a newer format leaves the order without
 * one. One that fewer than a majority sent never counts, whichever relays sent it.
 */
export function merchantAcceptanceOf(
  answers: ReadonlyMap<string, readonly unknown[]>,
  keys: MerchantAcceptanceKeys,
  invoice: AcceptedInvoice,
  relayCount: number
): MerchantAcceptance {
  /** Each copy opened once, by id and signature, whatever relays send it. */
  const copies = new Map<string, OpenedMerchantAcceptance | null>();
  const open = (value: unknown) => {
    if (!isObject(value) || typeof value.id !== "string" || typeof value.sig !== "string") {
      return openMerchantAcceptance(value, keys, invoice);
    }
    const copy = `${value.id}/${value.sig}`;
    if (!copies.has(copy)) copies.set(copy, openMerchantAcceptance(value, keys, invoice));
    return copies.get(copy)!;
  };
  /** The records that count if enough relays sent them, by id, and how many relays sent each. */
  const records = new Map<string, { opened: OpenedMerchantAcceptance; sentBy: number }>();
  let newer = false;
  for (const events of answers.values()) {
    const sent = new Set<string>();
    for (const value of events) {
      const opened = open(value);
      if (opened === null) continue;
      if (opened.status !== "ok") newer = true;
      if (opened.status === "newer, set aside") continue;
      const { id } = opened.event;
      // One relay counts once for a record, whatever copies of it it sent.
      if (sent.has(id)) continue;
      sent.add(id);
      const known = records.get(id);
      if (known) known.sentBy += 1;
      else records.set(id, { opened, sentBy: 1 });
    }
  }
  const needed = majority(relayCount);
  let newest: OpenedMerchantAcceptance | null = null;
  for (const { opened, sentBy } of records.values()) {
    if (sentBy < needed) continue;
    if (!newest || replaces(opened.event, newest.event)) newest = opened;
  }
  return { received: newest?.status === "ok" ? newest.received : null, newer };
}

/**
 * The merchant's acceptance of `invoice` (merchantAcceptanceOf), read on every relay of the
 * merchant's `relays` (SPEC.md §13: once every relay answered or failed, or one timeout after a
 * majority answered), not paged, with a key of this read alone. Throws NetworkError when fewer
 * than a majority answered. Publishes nothing.
 */
export async function readMerchantAcceptance(
  pool: RelayPool,
  keys: MerchantAcceptanceKeys,
  invoice: AcceptedInvoice,
  relays: readonly string[],
  options: { random: RandomBytes; signal?: AbortSignal | undefined }
): Promise<MerchantAcceptance> {
  const { answers, answered } = await pool.queryRelays(
    relays,
    { kinds: [RECORD_KIND], authors: [keys.team], "#d": [keys.address] },
    options.random(32),
    {
      paged: false,
      everyRelay: true,
      keep: recordsThatOpen((d, author) =>
        author === keys.team && d === keys.address ? keys.encryptionKey : null
      )
    }
  );
  if (options.signal?.aborted) throw options.signal.reason;
  if (!answered) {
    throw new NetworkError("Fewer than a majority of the merchant's relays answered");
  }
  return merchantAcceptanceOf(answers, keys, invoice, relays.length);
}
