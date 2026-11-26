import { isCheckoutOrigin } from "../../vendor/checkout-node/src/checkout.js";
import { lightningAddressUrl } from "../../vendor/checkout-node/src/lnurl.js";
import { isPublicKey } from "../../vendor/checkout-node/src/nostr/event.js";
import {
  NewerRecordError,
  newestRecord,
  openRecord,
  recordsThatOpen
} from "../../vendor/checkout-node/src/nostr/record.js";
import {
  bitcoinNodeOf,
  parseNodeUrl,
  type BitcoinNode
} from "../../vendor/checkout-node/src/onchain/node.js";
import { toleranceOf } from "../../vendor/checkout-node/src/onchain/tolerance.js";
import { MAX_RELAY_MOVES, RECORD_KIND } from "../../vendor/checkout-node/src/protocol.js";
import { parseRelayList, sameRelayList } from "../../vendor/checkout-node/src/relays.js";

import {
  CHANNEL_TYPE,
  CHANNEL_VERSION,
  NO_INVOICING_CHANNEL_VERSION,
  MAX_ASSISTANT_NAME,
  MAX_BUSINESS_FIELD,
  MAX_BUSINESS_NAME,
  MAX_BUSINESS_NUMBER,
  MAX_COUNTER_WRITERS,
  MAX_VAT_RATE
} from "./constants.js";
import type { Call } from "./context.js";
import { AssistantError } from "./errors.js";
import type { AssistantKey } from "./key.js";
import type { AssistantKeys } from "./keys.js";
import { isFilledText, isHex32, isObject, isTrimmedText, isUnixSeconds } from "./text.js";

/*
 * The assistant's channel (SPEC.md §5): one record signed by the team, which the merchant's app
 * writes on the account's relays and only the assistant key opens. Read again at each call: a
 * removal stops the very next invoice. Its value is read as the app reads it
 * (src/lib/team/channel.ts, channel-invoicing.ts), for what the assistant uses.
 */

export type BusinessAddress = {
  street: string;
  postalCode: string;
  city: string;
  country: string | null;
};

/** What an assistant's invoices print, and how it numbers them (SPEC.md §5, `invoicing`). */
export type Invoicing = {
  businessAddress: BusinessAddress | null;
  companyNumber: string;
  vatNumber: string;
  detectedCountry: string | null;
  /** The merchant's default VAT rate, basis points. */
  vatRate: number;
  /** The merchant's web app, where payment links open; null: no invoice. */
  linkOrigin: string | null;
  /** Hex: the shared counter's key. */
  counterKey: string;
  /** Hex: the invoices authors of the other writers of numbers. */
  counterWriters: string[];
};

export type Channel = {
  name: string;
  businessName: string;
  lightningAddress: string;
  /** ISO 4217: the account's currency, the invoices'. */
  currency: string;
  /** Whether the merchant takes on-chain payments. */
  onchain: boolean;
  registryKey: string;
  registryReader: string;
  linkOwner: string;
  /**
   * The merchant's link key reader (SPEC.md §5): the link secret is sealed for it in the link's
   * record (§12). Null in a channel of a merchant's app before it: sealed for `registryReader`.
   */
  linkKeyReader: string | null;
  relays: string[];
  /** Basis points, 0 when none. */
  tolerance: number;
  bitcoinNode: BitcoinNode | null;
  /** Null: the merchant created this assistant without invoices (version 2, SPEC.md §5). */
  invoicing: Invoicing | null;
  updatedAt: number;
};

const COUNTRY = /^[A-Z]{2}$/;

function isCountry(value: unknown): value is string {
  return typeof value === "string" && COUNTRY.test(value);
}

function parseBusinessAddress(value: unknown): BusinessAddress | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  const { street, postalCode, city, country } = value;
  if (
    !isTrimmedText(street, MAX_BUSINESS_FIELD) ||
    !isTrimmedText(postalCode, MAX_BUSINESS_FIELD) ||
    !isTrimmedText(city, MAX_BUSINESS_FIELD) ||
    !(country === null || isCountry(country))
  ) {
    return undefined;
  }
  return { street, postalCode, city, country };
}

/** An assistant channel's `invoicing`, null when it is not that whole. */
export function parseInvoicing(value: unknown): Invoicing | null {
  if (!isObject(value)) return null;
  const v = value;
  const businessAddress = parseBusinessAddress(v.businessAddress);
  if (businessAddress === undefined) return null;
  if (!isTrimmedText(v.companyNumber, MAX_BUSINESS_NUMBER)) return null;
  if (!isTrimmedText(v.vatNumber, MAX_BUSINESS_NUMBER)) return null;
  if (!(v.detectedCountry === null || isCountry(v.detectedCountry))) return null;
  const { vatRate } = v;
  if (!Number.isSafeInteger(vatRate) || (vatRate as number) < 0) return null;
  if ((vatRate as number) > MAX_VAT_RATE) return null;
  if (!(v.linkOrigin === null || isCheckoutOrigin(v.linkOrigin))) return null;
  if (!isHex32(v.counterKey)) return null;
  const writers = v.counterWriters;
  if (!Array.isArray(writers) || writers.length > MAX_COUNTER_WRITERS) return null;
  if (!writers.every(isPublicKey) || new Set(writers).size !== writers.length) return null;
  return {
    businessAddress,
    companyNumber: v.companyNumber,
    vatNumber: v.vatNumber,
    detectedCountry: v.detectedCountry,
    vatRate: vatRate as number,
    linkOrigin: v.linkOrigin,
    counterKey: v.counterKey,
    counterWriters: [...writers]
  };
}

/**
 * A channel's value: active (an assistant's, whole), removed, or null when invalid. Version 2 is
 * an assistant's without invoices: version 1 without `invoicing` (left aside when there).
 */
export function parseChannel(
  value: unknown,
  createdAt: number
): { status: "active"; channel: Channel } | { status: "removed" } | null {
  if (!isObject(value)) return null;
  const v = value;
  if (typeof v.version === "number" && v.version > NO_INVOICING_CHANNEL_VERSION) {
    throw new NewerRecordError();
  }
  const noInvoicing = v.version === NO_INVOICING_CHANNEL_VERSION;
  if ((v.version !== CHANNEL_VERSION && !noInvoicing) || !isUnixSeconds(v.updatedAt)) return null;
  if (v.updatedAt !== createdAt) return null;
  // A removal is of version 1 only.
  if (v.status === "removed") return noInvoicing ? null : { status: "removed" };
  if (v.status !== "active" || v.role !== "assistant") return null;
  if (!isFilledText(v.name, MAX_ASSISTANT_NAME)) return null;
  const profile = v.profile;
  if (!isObject(profile) || !isFilledText(profile.businessName, MAX_BUSINESS_NAME)) return null;
  const { lightningAddress, currency, onchain } = profile;
  if (typeof lightningAddress !== "string" || lightningAddressUrl(lightningAddress) === null) {
    return null;
  }
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  if (typeof onchain !== "boolean") return null;
  if (!isHex32(v.registryKey) || !isPublicKey(v.registryReader) || !isPublicKey(v.linkOwner)) {
    return null;
  }
  const relays = parseRelayList(v.relays);
  const invoicing = noInvoicing ? null : parseInvoicing(v.invoicing);
  if (relays === null || (!noInvoicing && invoicing === null)) return null;
  return {
    status: "active",
    channel: {
      name: v.name,
      businessName: profile.businessName,
      lightningAddress,
      currency,
      onchain,
      registryKey: v.registryKey,
      registryReader: v.registryReader,
      linkOwner: v.linkOwner,
      // Absent or invalid: none, and the channel stays valid (SPEC.md §5).
      linkKeyReader: isPublicKey(v.linkKeyReader) ? v.linkKeyReader : null,
      relays,
      // Absent or invalid: none, and the channel stays valid (spec/SPEC.md §14).
      tolerance: toleranceOf(v.onchainTolerance),
      bitcoinNode: bitcoinNodeOf(v.bitcoinNode),
      invoicing,
      updatedAt: createdAt
    }
  };
}

/**
 * What the channel gives to make and read invoices; throws AssistantError `invoicing_not_allowed`
 * for an assistant the merchant created without invoices (version 2): it makes none, reads none.
 */
export function invoicingOf(channel: Channel): Invoicing {
  if (channel.invoicing === null) {
    throw new AssistantError(
      "invoicing_not_allowed",
      "The merchant created this assistant without invoices: it can only export the transactions, when allowed"
    );
  }
  return channel.invoicing;
}

type Lookup =
  | { status: "found"; value: ReturnType<typeof parseChannel> & object }
  | { status: "notFound"; newer: boolean }
  | { status: "unreachable" };

async function lookup(
  call: Call,
  access: AssistantKey,
  keys: AssistantKeys,
  relays: readonly string[]
): Promise<Lookup> {
  const { address, encryptionKey } = keys.member.channel;
  const { answers, answered } = await call.pool.queryRelays(
    relays,
    { kinds: [RECORD_KIND], authors: [access.teamPublicKey], "#d": [address] },
    keys.member.nostr.secretKey,
    {
      paged: false,
      keep: recordsThatOpen((_, author) => (author === access.teamPublicKey ? encryptionKey : null))
    }
  );
  if (!answered) return { status: "unreachable" };
  const { newest, newestUnreadable } = newestRecord(answers, (value) =>
    openRecord(value, {
      type: CHANNEL_TYPE,
      encryptionKey,
      address,
      author: access.teamPublicKey,
      parse: (v, event) => parseChannel(v, event.created_at)
    })
  );
  if (newestUnreadable !== null && newestUnreadable > (newest?.event.created_at ?? -1)) {
    return { status: "notFound", newer: true };
  }
  return newest ? { status: "found", value: newest.value } : { status: "notFound", newer: false };
}

/**
 * The assistant's channel, active, on the account's current relays: read on the key's relays, then
 * where the channel says the account moved (MAX_RELAY_MOVES at most), as an integration's server
 * reads its own (spec/SPEC.md §14). Throws AssistantError: `revoked` when removed, `network` when
 * fewer than a majority of a list answered, `newer` for a channel of a newer format, `not_found`
 * when a majority of the key's relays answered without it.
 */
export async function readChannel(
  call: Call,
  access: AssistantKey,
  keys: AssistantKeys
): Promise<Channel> {
  let relays: readonly string[] = access.relays;
  let found = await lookup(call, access, keys, relays);
  if (found.status === "unreachable") {
    throw new AssistantError("network", "Fewer than a majority of the key's relays answered");
  }
  if (found.status === "notFound") {
    if (found.newer) {
      throw new AssistantError("newer", "The channel has a newer format: update this server");
    }
    throw new AssistantError("not_found", "The assistant's channel is not on the key's relays");
  }
  let value = found.value;
  for (let move = 0; move < MAX_RELAY_MOVES; move += 1) {
    if (value.status !== "active" || sameRelayList(value.channel.relays, relays)) break;
    const next = value.channel.relays;
    found = await lookup(call, access, keys, next);
    if (found.status === "unreachable") {
      throw new AssistantError(
        "network",
        "Fewer than a majority of the merchant's relays answered"
      );
    }
    // Not copied there (yet): the channel read so far stands.
    if (found.status === "notFound") break;
    value = found.value;
    relays = next;
  }
  if (value.status === "removed") {
    throw new AssistantError("revoked", "The merchant removed this assistant in the app");
  }
  return call.publicOnly ? withoutLocalNode(value.channel) : value.channel;
}

/**
 * The channel as the hosted server reads the blockchain for it: a Bitcoin node that is not of the
 * Internet (a local network's, an IP address, http) is on the merchant's network, not the
 * server's, which never connects there (src/hosted/egress.ts). Its fallback `"mempool"` reads
 * mempool.space in its place: the node set aside. Its fallback `"none"` (never mempool.space) keeps
 * it: its reads are refused, as the node's failure, and mempool.space is not read.
 */
function withoutLocalNode(channel: Channel): Channel {
  const node = channel.bitcoinNode;
  if (!node || node.fallback === "none" || parseNodeUrl(node.url)?.internet) return channel;
  return { ...channel, bitcoinNode: null };
}
