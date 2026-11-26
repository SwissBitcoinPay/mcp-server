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
import { isDepositAddress } from "../../vendor/checkout-node/src/onchain/address.js";
import { addressTransactions, Explorer } from "../../vendor/checkout-node/src/onchain/explorer.js";
import { RECORD_KIND } from "../../vendor/checkout-node/src/protocol.js";

import type { Channel } from "./channel.js";
import { LOT_SIZES, LOT_TYPE, LOT_VERSION, USED_TYPE } from "./constants.js";
import type { Call } from "./context.js";
import type { AssistantKey } from "./key.js";
import { lotAddress, usedAddress, type AssistantKeys } from "./keys.js";
import { isObject, isUnixSeconds } from "./text.js";

/*
 * The assistant's deposit addresses (SPEC.md §10): the lot the owner gives it (signed by the team,
 * sealed with the channel's key) and the addresses it used (its own record), as the merchant's app
 * writes them for an employee's device (src/lib/team/onchain-lot.ts). The owner drops the used
 * addresses and fills the lot again when it opens the app. A lot of version 1 holds 20 addresses
 * at most, of version 2 (an assistant's) 100; the used record takes the version of the lot read.
 */

export type Lot = { version: number; addresses: string[]; tags: string[]; updatedAt: number };
export type Used = { version: number; used: string[]; lotAt: number; updatedAt: number };

const TAG = /^[0-9a-f]{16}$/;

/** A version this assistant reads (LOT_SIZES); one above LOT_VERSION is of a newer format. */
function versionOf(value: Record<string, unknown>): number | null {
  const { version } = value;
  if (typeof version === "number" && version > LOT_VERSION) throw new NewerRecordError();
  return typeof version === "number" && LOT_SIZES[version] !== undefined ? version : null;
}

function parseAddresses(value: unknown, version: number): string[] | null {
  if (!Array.isArray(value) || value.length > LOT_SIZES[version]!) return null;
  const addresses: string[] = [];
  for (const item of value as unknown[]) {
    if (!isDepositAddress(item) || addresses.includes(item)) return null;
    addresses.push(item);
  }
  return addresses;
}

/**
 * A lot's value; null when invalid. Throws NewerRecordError for a version above LOT_VERSION (the
 * lot is then empty, SPEC.md §10).
 */
export function parseLot(value: unknown, createdAt: number): Lot | null {
  if (!isObject(value)) return null;
  const version = versionOf(value);
  if (version === null) return null;
  if (!isUnixSeconds(value.updatedAt) || value.updatedAt !== createdAt) return null;
  const addresses = parseAddresses(value.addresses, version);
  const tags = value.tags;
  if (!addresses || !Array.isArray(tags) || tags.length !== addresses.length) return null;
  if (!tags.every((tag) => typeof tag === "string" && TAG.test(tag))) return null;
  return { version, addresses, tags: tags as string[], updatedAt: value.updatedAt };
}

/** A used record's value; null when invalid. Throws NewerRecordError as parseLot. */
export function parseUsed(value: unknown, createdAt: number): Used | null {
  if (!isObject(value)) return null;
  const version = versionOf(value);
  if (version === null) return null;
  if (!isUnixSeconds(value.updatedAt) || value.updatedAt !== createdAt) return null;
  if (!isUnixSeconds(value.lotAt)) return null;
  const used = parseAddresses(value.used, version);
  return used ? { version, used, lotAt: value.lotAt, updatedAt: value.updatedAt } : null;
}

export function usedEvent(keys: AssistantKeys, used: Used, call: Pick<Call, "random">): NostrEvent {
  return sealRecord({
    type: USED_TYPE,
    value: { version: used.version, used: used.used, lotAt: used.lotAt, updatedAt: used.updatedAt },
    signer: keys.member.nostr.secretKey,
    encryptionKey: keys.member.records.encryptionKey,
    address: usedAddress(keys),
    createdAt: used.updatedAt,
    random: call.random
  });
}

/** Whether a copy of a newer format is the newest the relays hold. */
function newerThanRead(found: NewestRecord<unknown>): boolean {
  return (
    found.newestUnreadable !== null &&
    found.newestUnreadable >= (found.newest?.event.created_at ?? -1)
  );
}

/**
 * What the relays hold of the lot and the used addresses; null when fewer than a majority
 * answered. `newer`: the newest used record is of a newer format (SPEC.md §10: none is taken, it is
 * never written over); the newest lot of a newer format is no lot (an empty lot).
 */
async function readLot(
  call: Call,
  access: AssistantKey,
  keys: AssistantKeys,
  relays: readonly string[]
): Promise<{
  lot: Lot | null;
  used: { value: Used; createdAt: number } | null;
  newer: boolean;
} | null> {
  const lotAt = lotAddress(keys);
  const usedAt = usedAddress(keys);
  const team = access.teamPublicKey;
  const member = keys.member.nostr.publicKey;
  const [lots, used] = await Promise.all([
    call.pool.queryRelays(
      relays,
      { kinds: [RECORD_KIND], authors: [team], "#d": [lotAt] },
      keys.member.nostr.secretKey,
      {
        paged: false,
        keep: recordsThatOpen((_, author) =>
          author === team ? keys.member.channel.encryptionKey : null
        )
      }
    ),
    call.pool.queryRelays(
      relays,
      { kinds: [RECORD_KIND], authors: [member], "#d": [usedAt] },
      keys.member.nostr.secretKey,
      {
        paged: false,
        keep: recordsThatOpen((_, author) =>
          author === member ? keys.member.records.encryptionKey : null
        )
      }
    )
  ]);
  if (!lots.answered || !used.answered) return null;
  const lotRead = newestRecord(lots.answers, (value) =>
    openRecord(value, {
      type: LOT_TYPE,
      encryptionKey: keys.member.channel.encryptionKey,
      address: lotAt,
      author: team,
      parse: (v, event) => parseLot(v, event.created_at)
    })
  );
  const usedRead = newestRecord(used.answers, (value) =>
    openRecord(value, {
      type: USED_TYPE,
      encryptionKey: keys.member.records.encryptionKey,
      address: usedAt,
      author: member,
      parse: (v, event) => parseUsed(v, event.created_at)
    })
  );
  const latest = usedRead.newest;
  return {
    // A lot of a newer format is the newest: an older copy (a relay behind) is not the lot.
    lot: newerThanRead(lotRead) ? null : (lotRead.newest?.value ?? null),
    used: latest
      ? {
          value: latest.value,
          createdAt: Math.max(latest.event.created_at, usedRead.newestUnreadable ?? 0)
        }
      : null,
    newer: newerThanRead(usedRead)
  };
}

/** An address taken, with the owner's tag of it; or why none was. */
export type AddressTake =
  { address: string; tag: string } | { address: null; reason: "network" | "empty" };

/**
 * Takes a deposit address of the assistant's lot (SPEC.md §10): the first one not used that the
 * explorer shows nothing ever paid, recorded as used on a majority of the merchant's relays before
 * it is given. The caller takes addresses one at a time for a key (a lock: SPEC.md §17).
 */
export async function takeAddress(
  call: Call,
  access: AssistantKey,
  keys: AssistantKeys,
  channel: Channel
): Promise<AddressTake> {
  const relays = channel.relays;
  const read = await readLot(call, access, keys, relays);
  if (read === null) return { address: null, reason: "network" };
  const { lot } = read;
  // No lot, or used addresses of a newer format (a newer assistant's): which were used is unknown,
  // and that record is never written over.
  if (lot === null || read.newer) return { address: null, reason: "empty" };
  // Used addresses still in the lot: the others were dropped by the owner.
  const used = (read.used?.value.used ?? []).filter((address) => lot.addresses.includes(address));
  const explorer = new Explorer(channel.bitcoinNode, new Map(), () => call.now() * 1000);
  const paidBefore: string[] = [];
  let taken: { address: string; tag: string } | null = null;
  // The explorer silent: no address is shown while not proven unused, and none is marked used
  // (an outage would empty the lot).
  let silent = false;
  for (const [index, address] of lot.addresses.entries()) {
    if (used.includes(address)) continue;
    let txs;
    try {
      txs = await explorer.read(call.http, (base, http) =>
        addressTransactions(base, address, http)
      );
    } catch {
      silent = true;
      break;
    }
    if (txs.length > 0) {
      paidBefore.push(address);
      continue;
    }
    taken = { address, tag: lot.tags[index]! };
    break;
  }
  if (taken === null && paidBefore.length === 0) {
    return { address: null, reason: silent ? "network" : "empty" };
  }
  const updatedAt = Math.max(call.now(), (read.used?.createdAt ?? 0) + 1);
  const record: Used = {
    // The lot's version: never more addresses than it holds.
    version: lot.version,
    used: [...used, ...paidBefore, ...(taken ? [taken.address] : [])],
    lotAt: lot.updatedAt,
    updatedAt
  };
  try {
    await call.pool.publishToQuorum(
      relays,
      usedEvent(keys, record, call),
      keys.member.nostr.secretKey,
      majority(relays.length)
    );
  } catch {
    return { address: null, reason: "network" };
  }
  return taken ?? { address: null, reason: silent ? "network" : "empty" };
}
