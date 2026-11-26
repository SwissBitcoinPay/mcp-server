import { checkoutOriginOf } from "./checkout.js";
import { channelKeys } from "./derive.js";
import { ChannelNotFoundError, NetworkError, RevokedError } from "./errors.js";
import type { IntegrationKey } from "./key.js";
import { lightningAddressUrl } from "./lnurl.js";
import { isPublicKey } from "./nostr/event.js";
import { NewerRecordError, newestRecord, openRecord, recordsThatOpen } from "./nostr/record.js";
import type { RelayPool } from "./nostr/relay.js";
import { bitcoinNodeOf, type BitcoinNode } from "./onchain/node.js";
import { toleranceOf } from "./onchain/tolerance.js";
import {
  CHANNEL_RECORD_TYPE,
  CHANNEL_VERSION,
  MAX_BUSINESS_NAME_LENGTH,
  MAX_RELAY_MOVES,
  RECORD_KIND
} from "./protocol.js";
import { secureRandomBytes, type RandomBytes } from "./random.js";
import { parseRelayList, sameRelayList } from "./relays.js";
import { codePointLength, isHex32, isObject, isWellFormed, trimAscii } from "./text.js";
import type { Logger } from "./types.js";

/*
 * The integration's channel (SPEC.md, "Reading the channel"): one record signed by the team, which the merchant's app publishes on
 * the account's relays and which only the integration's key opens. It gives the merchant's
 * Lightning address, registry and relays, or says that the integration was removed.
 */

/** The channel, as far as the server uses it. */
export type Channel =
  | {
      status: "active";
      businessName: string;
      /** Never shown to the integrator by the app: the package does not return it either. */
      lightningAddress: string;
      /** Hex, 32 bytes. */
      registryKey: string;
      /** Hex: the public half of the merchant's reading key. */
      registryReader: string;
      /** The account's relays, when the channel names them. */
      relays?: string[];
      /**
       * The merchant's web app for checkout links (`checkout.origin`), null when the merchant's app
       * gives none (a version without a web app) or an invalid one.
       */
      checkoutOrigin: string | null;
      /**
       * The merchant's tolerance of on-chain underpayments (`onchainTolerance`, basis points:
       * SPEC.md, "The merchant's tolerance"), 0 when the channel gives none or an invalid one. An
       * order's lease keeps it; never returned to the integrator.
       */
      tolerance: number;
      /**
       * The merchant's Bitcoin node (`bitcoinNode`, SPEC.md §31, "The merchant's Bitcoin node"),
       * which the server reads the blockchain from; null when the channel names none or an
       * invalid one (mempool.space).
       */
      bitcoinNode: BitcoinNode | null;
      /** Unix seconds: the record's `created_at`. */
      updatedAt: number;
    }
  | { status: "removed"; updatedAt: number };

/**
 * A channel's value, as the merchant's app reads it, for what the server uses: version 1,
 * `updatedAt` = `created_at`, then removed, or active with the role of an integration, the
 * business's name, a Lightning address, the registry and an optional valid relay list, and the
 * web app of checkout links when it gives a valid one (an invalid one gives none, and leaves the
 * channel valid), the merchant's tolerance of on-chain underpayments (absent or invalid: none,
 * the channel valid), and the merchant's Bitcoin node (absent or invalid: none, the channel
 * valid). The other fields (the profile's currency and logo, linkOwner) are the app's own
 * and not read here, so that a change to them never stops a shop's server. Throws
 * NewerRecordError for a newer version.
 */
export function parseChannel(value: unknown, createdAt: number): Channel | null {
  if (!isObject(value)) return null;
  const v = value;
  if (typeof v.version === "number" && v.version > CHANNEL_VERSION) throw new NewerRecordError();
  if (v.version !== CHANNEL_VERSION || v.updatedAt !== createdAt) return null;
  if (v.status === "removed") return { status: "removed", updatedAt: createdAt };
  if (v.status !== "active" || v.role !== "integration") return null;
  const profile = v.profile;
  if (!isObject(profile)) return null;
  const { businessName, lightningAddress } = profile;
  if (
    typeof businessName !== "string" ||
    !isWellFormed(businessName) ||
    trimAscii(businessName) === "" ||
    codePointLength(businessName) > MAX_BUSINESS_NAME_LENGTH
  ) {
    return null;
  }
  if (typeof lightningAddress !== "string" || lightningAddressUrl(lightningAddress) === null) {
    return null;
  }
  // The reading key must be a point of the curve: every declaration's inside is sealed to it.
  if (!isHex32(v.registryKey) || !isPublicKey(v.registryReader)) return null;
  const relays = v.relays === undefined ? undefined : parseRelayList(v.relays);
  if (relays === null) return null;
  return {
    status: "active",
    businessName,
    lightningAddress,
    registryKey: v.registryKey,
    registryReader: v.registryReader,
    ...(relays ? { relays } : {}),
    checkoutOrigin: checkoutOriginOf(v.checkout),
    // Absent or invalid, none: the channel stays valid (SPEC.md, "Reading the channel").
    tolerance: toleranceOf(v.onchainTolerance),
    // Absent or invalid in any way, none: mempool.space, and the channel stays valid.
    bitcoinNode: bitcoinNodeOf(v.bitcoinNode),
    updatedAt: createdAt
  };
}

export type ChannelReadOptions = {
  signal?: AbortSignal | undefined;
  random?: RandomBytes | undefined;
  logger: Logger;
};

/** What the relays of one list hold. */
export type ChannelLookup =
  | { status: "found"; channel: Channel }
  /** A majority of the relays answered: no channel, or only one of a newer format (`newer`). */
  | { status: "notFound"; newer: boolean }
  /** Fewer than a majority of the relays answered. */
  | { status: "unreachable" };

/**
 * The newest copy of the integration's channel on `relays`, signed by its team, over the
 * connections of `pool`: every relay at once, read as soon as a majority of them answered (the app
 * publishes the channel, and its removal, on a majority of them: any two majorities share a
 * relay). Never rejects but for an aborted `signal`.
 */
export async function lookupChannel(
  pool: RelayPool,
  access: IntegrationKey,
  relays: readonly string[],
  options: ChannelReadOptions
): Promise<ChannelLookup> {
  const keys = channelKeys(access.key);
  const random = options.random ?? secureRandomBytes;
  // A relay that asks to authenticate (NIP-42) gets a key of this read alone.
  const authKey = random(32);
  const { answers, answered } = await pool.queryRelays(
    relays,
    { kinds: [RECORD_KIND], authors: [access.teamPublicKey], "#d": [keys.address] },
    authKey,
    {
      paged: false,
      keep: recordsThatOpen((_, author) =>
        author === access.teamPublicKey ? keys.encryptionKey : null
      )
    }
  );
  if (options.signal?.aborted) throw options.signal.reason;
  if (!answered) return { status: "unreachable" };
  const { newest, newestUnreadable } = newestRecord(answers, (value) =>
    openRecord(value, {
      type: CHANNEL_RECORD_TYPE,
      encryptionKey: keys.encryptionKey,
      address: keys.address,
      author: access.teamPublicKey,
      parse: (v, event) => parseChannel(v, event.created_at)
    })
  );
  if (newestUnreadable !== null && newestUnreadable > (newest?.event.created_at ?? -1)) {
    options.logger.warn(
      "@sattleme/checkout: the integration's channel has a newer format than this " +
        "version reads; update the package"
    );
  }
  return newest
    ? { status: "found", channel: newest.value }
    : { status: "notFound", newer: newestUnreadable !== null };
}

/** The integration's channel, active, and the relays it was read on (readChannel). */
export type ChannelRead = {
  channel: Extract<Channel, { status: "active" }>;
  relays: readonly string[];
};

/**
 * The integration's channel, active, on the account's current relays: read on the key's relays,
 * then where the channel says the account moved (MAX_RELAY_MOVES at most), since only the new list
 * gets its later changes, its removal included. Returns it with the relays it was read on. Throws
 * RevokedError when it is removed, NetworkError when fewer than a majority of a list answered,
 * ChannelNotFoundError when a majority of the key's relays answered without it.
 */
export async function readChannel(
  pool: RelayPool,
  access: IntegrationKey,
  options: ChannelReadOptions
): Promise<ChannelRead> {
  let relays: readonly string[] = access.relays;
  let lookup = await lookupChannel(pool, access, relays, options);
  if (lookup.status === "unreachable") {
    throw new NetworkError("Fewer than a majority of the integration key's relays answered");
  }
  if (lookup.status === "notFound") throw new ChannelNotFoundError(lookup.newer);
  let channel = lookup.channel;
  for (let move = 0; move < MAX_RELAY_MOVES; move += 1) {
    if (channel.status !== "active" || !channel.relays || sameRelayList(channel.relays, relays)) {
      break;
    }
    const next = channel.relays;
    lookup = await lookupChannel(pool, access, next, options);
    if (lookup.status === "unreachable") {
      throw new NetworkError("Fewer than a majority of the merchant's relays answered");
    }
    // Not copied there (yet): the channel read so far stands, and the declarations still go to
    // the account's relays it names.
    if (lookup.status === "notFound") break;
    channel = lookup.channel;
    relays = next;
  }
  if (channel.status === "removed") throw new RevokedError();
  return { channel, relays };
}
