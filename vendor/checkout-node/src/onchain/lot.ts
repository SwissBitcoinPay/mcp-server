import { channelKeys, lotAddress } from "../derive.js";
import { NetworkError } from "../errors.js";
import type { IntegrationKey } from "../key.js";
import { NewerRecordError, newestRecord, openRecord, recordsThatOpen } from "../nostr/record.js";
import type { RelayPool } from "../nostr/relay.js";
import { LOT_RECORD_TYPE, LOT_VERSION, MAX_LOT_ADDRESSES, RECORD_KIND } from "../protocol.js";
import type { RandomBytes } from "../random.js";
import { isObject } from "../text.js";
import type { Logger } from "../types.js";

import { isDepositAddress } from "./address.js";

/*
 * The integration's lot (SPEC.md, "The lot"): deposit addresses of the merchant's wallet, which the
 * merchant's app gives the integration and fills again whenever the merchant opens it. One record
 * signed by the team, sealed with the channel's key, at an address the integration key derives.
 * The package only reads it: it never makes an address, and never writes the lot.
 */

/**
 * A lot's value: version 1, `updatedAt` its event's `created_at`, 0 to 100 deposit addresses,
 * none twice. Null when it is not valid; throws NewerRecordError for a newer version.
 */
export function parseLot(value: unknown, createdAt: number): string[] | null {
  if (!isObject(value)) return null;
  if (typeof value.version === "number" && value.version > LOT_VERSION) {
    throw new NewerRecordError();
  }
  if (value.version !== LOT_VERSION || value.updatedAt !== createdAt) return null;
  const { addresses } = value;
  if (!Array.isArray(addresses) || addresses.length > MAX_LOT_ADDRESSES) return null;
  const lot: string[] = [];
  for (const address of addresses as unknown[]) {
    if (!isDepositAddress(address) || lot.includes(address)) return null;
    lot.push(address);
  }
  return lot;
}

/**
 * The addresses of the integration's lot, read on the merchant's `relays` as soon as a majority
 * answered: the newest valid copy. Empty when there is none, or when a copy of a newer format is
 * newer than it (logged: update the package). The order means nothing. Throws NetworkError when
 * fewer than a majority answered.
 */
export async function readLot(
  pool: RelayPool,
  access: IntegrationKey,
  relays: readonly string[],
  options: { signal?: AbortSignal | undefined; random: RandomBytes; logger: Logger }
): Promise<string[]> {
  const address = lotAddress(access.key);
  const { encryptionKey } = channelKeys(access.key);
  // A relay that asks to authenticate (NIP-42) gets a key of this read alone.
  const { answers, answered } = await pool.queryRelays(
    relays,
    { kinds: [RECORD_KIND], authors: [access.teamPublicKey], "#d": [address] },
    options.random(32),
    {
      paged: false,
      keep: recordsThatOpen((_, author) => (author === access.teamPublicKey ? encryptionKey : null))
    }
  );
  if (options.signal?.aborted) throw options.signal.reason;
  if (!answered) {
    throw new NetworkError("Fewer than a majority of the merchant's relays answered");
  }
  const { newest, newestUnreadable } = newestRecord(answers, (value) =>
    openRecord(value, {
      type: LOT_RECORD_TYPE,
      encryptionKey,
      address,
      author: access.teamPublicKey,
      parse: (v, event) => parseLot(v, event.created_at)
    })
  );
  if (newestUnreadable !== null && newestUnreadable >= (newest?.event.created_at ?? -1)) {
    options.logger.warn(
      "@sattleme/checkout: the integration's lot of addresses has a newer format than " +
        "this version reads; update the package (no on-chain payment until then)"
    );
    return [];
  }
  return newest?.value ?? [];
}
