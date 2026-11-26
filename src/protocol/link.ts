import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import { lightningAddressUrl } from "../../vendor/checkout-node/src/lnurl.js";
import { deriveKey, type Sale } from "../../vendor/checkout-node/src/derive.js";
import { bytesToBase64Url } from "../../vendor/checkout-node/src/encoding.js";
import { decodeBolt11 } from "../../vendor/checkout-node/src/lightning/bolt11.js";
import { publicKeyOf, type NostrEvent } from "../../vendor/checkout-node/src/nostr/event.js";
import { conversationKey, nip44Encrypt } from "../../vendor/checkout-node/src/nostr/nip44.js";
import { sealRecord } from "../../vendor/checkout-node/src/nostr/record.js";
import { isDepositAddress } from "../../vendor/checkout-node/src/onchain/address.js";
import type { RecordNode } from "../../vendor/checkout-node/src/onchain/node.js";
import { recordNodeOf } from "../../vendor/checkout-node/src/onchain/node.js";
import { SALE_NOSTR_SECRET_INFO, SALE_SALT } from "../../vendor/checkout-node/src/protocol.js";
import type { RandomBytes } from "../../vendor/checkout-node/src/random.js";
import { takerTag } from "../../vendor/checkout-node/src/derive.js";

import {
  HOUR_SECONDS,
  LINK_ADDRESS_PREFIX,
  LINK_PATH,
  LINK_RECORD_TYPE,
  LINK_RECORD_VERSION,
  LINK_TYPE,
  LINK_VERSION,
  MAX_CURRENCY_DIGITS,
  MAX_FINAL_PAYMENTS,
  MAX_LINK_TEXT,
  MAX_REDIRECT_URL,
  MAX_SALE_SECONDS,
  OWNER_FINAL_PREFIX,
  OWNER_TWEAK_PREFIX
} from "./constants.js";
import { encodeRelayList } from "./key.js";
import { linkRecordAddress, type AssistantKeys } from "./keys.js";
import { satsAt } from "./points.js";
import { isFilledText, isHex32, isObject, isText } from "./text.js";
import { isRedirectUrl } from "./invoice.js";

/*
 * An invoice's payment link (SPEC.md §11), its record for the merchant's app (§12), and the final
 * version the app writes once the sale is settled (§15), as the merchant's app writes and reads them
 * (src/lib/payment-link/). The link is the sale: its key (in the URL) gives the sale's keys, which
 * sign the payer's declarations; its own secret signs it once and goes to the owner only, sealed in
 * the link's record.
 */

export type LinkFiat = { minor: number; digits: number; currency: string };

/** A payment link's value, version 4, as an assistant writes it (members in this order). */
export type LinkPayload = {
  version: typeof LINK_VERSION;
  businessName: string;
  lightningAddress: string;
  fiat: LinkFiat;
  note: string;
  onchainAddress: string | null;
  startsAt: number;
  endsAt: number;
  redirectUrl?: string;
  registryKey: string;
  registryReader: string;
  owner: string;
  taker: string;
  bitcoinNode?: RecordNode;
};

/** The `d` tag of the link of the sale whose key is `saleKey` (and of its own final version). */
export function linkAddress(saleKey: Uint8Array): string {
  return bytesToHex(sha256(concatBytes(utf8ToBytes(LINK_ADDRESS_PREFIX), saleKey)));
}

/** The `d` tag of the owner's final version of the link whose author is `author` (hex). */
export function ownerFinalAddress(author: string): string {
  return bytesToHex(sha256(concatBytes(utf8ToBytes(OWNER_FINAL_PREFIX), hexToBytes(author))));
}

/**
 * The sale's owner key (x only, hex): the link owner key `owner` tweaked by the sale key, Q = P +
 * t·G (SPEC.md §15), as the merchant's app computes it (owner-key.ts). Throws for a key that cannot
 * be one (off the curve, a tweak of 0).
 */
export function saleOwnerKey(owner: string, saleKey: Uint8Array): string {
  if (!isHex32(owner)) throw new Error("Not an owner key");
  const order = secp256k1.Point.Fn.ORDER;
  const tweak =
    BigInt(
      `0x${bytesToHex(sha256(concatBytes(utf8ToBytes(OWNER_TWEAK_PREFIX), hexToBytes(owner), saleKey)))}`
    ) % order;
  if (tweak === 0n) throw new Error("Unusable tweak");
  const point = secp256k1.Point.fromHex(`02${owner}`).add(secp256k1.Point.BASE.multiply(tweak));
  return point.toAffine().x.toString(16).padStart(64, "0");
}

/**
 * The sale of the link whose key is `saleKey`, as the vendored declarations' reader takes it: its
 * secret and author, its taker tag (of `takerKey`), and the merchant's registry.
 */
export function linkSale(
  saleKey: Uint8Array,
  registry: { registryKey: string; registryReader: string },
  taker: string
): Sale {
  const secretKey = deriveKey(saleKey, SALE_SALT, SALE_NOSTR_SECRET_INFO);
  return {
    ref: "",
    key: saleKey,
    secretKey,
    author: publicKeyOf(secretKey),
    taker,
    registry: { key: hexToBytes(registry.registryKey), reader: registry.registryReader },
    innerKey: conversationKey(secretKey, registry.registryReader)
  };
}

/** The taker tag of the sale whose author is `saleAuthor`, for this assistant. */
export function assistantTakerTag(keys: AssistantKeys, saleAuthor: string): string {
  return takerTag(keys.takerKey, saleAuthor);
}

/** A link's own secret: 32 random bytes, drawn again until they are a valid secp256k1 key. */
export function newLinkSecret(random: RandomBytes): Uint8Array {
  for (;;) {
    const secret = random(32);
    if (secp256k1.utils.isValidSecretKey(secret)) return secret;
  }
}

/** `<origin>/pay#<author>.<sale key>.<relays>` (SPEC.md §11). */
export function linkUrl(
  origin: string,
  author: string,
  saleKey: Uint8Array,
  relays: readonly string[]
): string {
  return `${origin}${LINK_PATH}#${bytesToBase64Url(hexToBytes(author))}.${bytesToBase64Url(saleKey)}.${encodeRelayList(relays)}`;
}

/** The link's event, signed by its own secret, dated when it starts. */
export function linkEvent(
  secret: Uint8Array,
  saleKey: Uint8Array,
  payload: LinkPayload,
  random: RandomBytes
): NostrEvent {
  return sealRecord({
    type: LINK_TYPE,
    value: payload,
    signer: secret,
    encryptionKey: saleKey,
    address: linkAddress(saleKey),
    createdAt: payload.startsAt,
    random
  });
}

/** The link's record for the merchant's app (SPEC.md §12). */
export type LinkRecord = {
  version: typeof LINK_RECORD_VERSION;
  link: string;
  saleKey: string;
  createdAt: number;
  onchainTag: string | null;
  relays: string[];
  sealedKey: string;
  /** Present when `sealedKey` is sealed for the channel's `linkKeyReader` (SPEC.md §12). */
  sealedFor?: "link-key-reader";
  tolerance?: number;
};

/** The link's secret, sealed for the merchant's key `reader` alone (NIP-44, ECDH). */
export function sealLinkSecret(secret: Uint8Array, reader: string, random: RandomBytes): string {
  return nip44Encrypt(bytesToHex(secret), conversationKey(secret, reader), random);
}

/**
 * The link's secret as its record holds it (SPEC.md §12): sealed for the channel's
 * `linkKeyReader`, which no export grant gives; for its `registryReader` (whose secret a grant
 * gives) only in a channel of an older version of the merchant's app, which names none.
 */
export function sealedLinkSecret(
  secret: Uint8Array,
  channel: { registryReader: string; linkKeyReader: string | null },
  random: RandomBytes
): Pick<LinkRecord, "sealedKey" | "sealedFor"> {
  return channel.linkKeyReader !== null
    ? {
        sealedKey: sealLinkSecret(secret, channel.linkKeyReader, random),
        sealedFor: "link-key-reader"
      }
    : { sealedKey: sealLinkSecret(secret, channel.registryReader, random) };
}

export function linkRecordEvent(
  keys: AssistantKeys,
  record: LinkRecord,
  random: RandomBytes
): NostrEvent {
  return sealRecord({
    type: LINK_RECORD_TYPE,
    value: record,
    signer: keys.member.links.secretKey,
    encryptionKey: keys.member.records.encryptionKey,
    address: linkRecordAddress(keys, record.link),
    createdAt: record.createdAt,
    random
  });
}

/** Whether `secret` signs as `author`. */
export function isSecretOf(secret: Uint8Array, author: string): boolean {
  try {
    return bytesToHex(schnorr.getPublicKey(secret)) === author;
  } catch {
    return false;
  }
}

/* Reading a link back (its published payload) and its final version (SPEC.md §15). */

const SATS = /^(0|[1-9][0-9]{0,15})$/;

function fiatOf(value: unknown): LinkFiat | null {
  if (!isObject(value)) return null;
  const { minor, digits, currency } = value;
  if (!Number.isSafeInteger(minor) || (minor as number) <= 0) return null;
  if (
    !Number.isInteger(digits) ||
    (digits as number) < 0 ||
    (digits as number) > MAX_CURRENCY_DIGITS
  ) {
    return null;
  }
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  return { minor: minor as number, digits: digits as number, currency };
}

/** A link's sale, as a payload of version 4 gives it (the payer's page's reading). */
export type LinkSale = {
  businessName: string;
  lightningAddress: string;
  fiat: LinkFiat;
  note: string;
  onchainAddress: string | null;
  startsAt: number;
  endsAt: number;
  redirectUrl: string | null;
  registryKey: string;
  registryReader: string;
  owner: string;
  taker: string | null;
  bitcoinNode: RecordNode | null;
  final: SaleFinal | null;
};

export type FinalLightning = {
  invoice: string;
  preimage: string;
  sats: bigint;
  paymentHash: string;
  /** Unix seconds: when the invoice was made (its BOLT11 timestamp). */
  timestamp: number;
};
export type FinalOnchain = {
  address: string;
  transactions: { txid: string; receivedAt: number; sats: bigint }[];
  sats: bigint;
};

/** A sale's outcome, as the merchant's app settled it. */
export type SaleFinal = {
  status: "paid" | "underpaid" | "expired" | "canceled";
  received: bigint;
  due: bigint | null;
  point: { hour: number; rate: number } | null;
  lightning: FinalLightning[];
  onchain: FinalOnchain | null;
  link: string;
  accepted: boolean;
};

function isPositiveSafe(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function lightningOf(value: unknown): FinalLightning[] | null {
  if (!Array.isArray(value) || value.length > MAX_FINAL_PAYMENTS) return null;
  const paid: FinalLightning[] = [];
  for (const entry of value as unknown[]) {
    if (!isObject(entry)) return null;
    const { invoice, preimage } = entry;
    if (typeof invoice !== "string" || !isHex32(preimage)) return null;
    const decoded = decodeBolt11(invoice);
    if (
      !decoded ||
      decoded.network !== "bc" ||
      decoded.amountMsat === null ||
      decoded.amountMsat <= 0n ||
      decoded.amountMsat % 1000n !== 0n ||
      bytesToHex(sha256(hexToBytes(preimage))) !== decoded.paymentHash ||
      paid.some((known) => known.paymentHash === decoded.paymentHash)
    ) {
      return null;
    }
    paid.push({
      invoice,
      preimage,
      sats: decoded.amountMsat / 1000n,
      paymentHash: decoded.paymentHash,
      timestamp: decoded.timestamp
    });
  }
  return paid;
}

function onchainOf(value: unknown, address: string | null): FinalOnchain | null | undefined {
  if (value === null) return address === null ? null : undefined;
  if (!isObject(value) || address === null) return undefined;
  if (value.address !== address || typeof value.sats !== "string" || !SATS.test(value.sats)) {
    return undefined;
  }
  const txs = value.transactions;
  if (
    value.sats === "0" ||
    !Array.isArray(txs) ||
    txs.length === 0 ||
    txs.length > MAX_FINAL_PAYMENTS
  ) {
    return undefined;
  }
  const transactions: FinalOnchain["transactions"] = [];
  for (const entry of txs as unknown[]) {
    if (!isObject(entry)) return undefined;
    const { txid, receivedAt, sats } = entry;
    if (!isHex32(txid) || !isPositiveSafe(receivedAt) || typeof sats !== "string") return undefined;
    if (!SATS.test(sats) || sats === "0" || transactions.some((known) => known.txid === txid)) {
      return undefined;
    }
    transactions.push({ txid, receivedAt, sats: BigInt(sats) });
  }
  const sum = transactions.reduce((total, tx) => total + tx.sats, 0n);
  return sum === BigInt(value.sats) ? { address, transactions, sats: sum } : undefined;
}

/** The highest tolerance there is (basis points): what a final version may say was accepted. */
const MAX_TOLERANCE = 1000n;

/** A final version's `final`, for the sale of `fiat` and the final payload's `address`. */
export function parseSaleFinal(
  value: unknown,
  fiat: LinkFiat,
  address: string | null
): SaleFinal | null {
  if (!isObject(value)) return null;
  const v = value;
  const status = v.status;
  if (
    status !== "paid" &&
    status !== "underpaid" &&
    status !== "expired" &&
    status !== "canceled"
  ) {
    return null;
  }
  if (typeof v.received !== "string" || !SATS.test(v.received) || !isHex32(v.link)) return null;
  if (v.accepted !== undefined && (v.accepted !== true || status !== "paid")) return null;
  const accepted = v.accepted === true;
  const lightning = lightningOf(v.lightning);
  const onchain = onchainOf(v.onchain, address);
  if (lightning === null || onchain === undefined) return null;
  const received = BigInt(v.received);
  if (lightning.reduce((sum, paid) => sum + paid.sats, onchain?.sats ?? 0n) !== received)
    return null;
  const base = { received, lightning, onchain, link: v.link, accepted };
  if (status === "expired" || status === "canceled") {
    return v.due === null && v.point === null && received === 0n
      ? { status, due: null, point: null, ...base }
      : null;
  }
  const point = v.point;
  if (typeof v.due !== "string" || !SATS.test(v.due) || !isObject(point)) return null;
  if (!isPositiveSafe(point.hour) || point.hour % HOUR_SECONDS !== 0) return null;
  if (typeof point.rate !== "number" || !Number.isFinite(point.rate) || point.rate <= 0)
    return null;
  const due = BigInt(v.due);
  let fixed: bigint;
  try {
    fixed = satsAt(fiat.minor, fiat.digits, point.rate);
  } catch {
    return null;
  }
  if (due !== fixed || due <= 0n) return null;
  if (status === "paid") {
    const least = due - (due * MAX_TOLERANCE) / 10_000n;
    if (accepted ? received >= due || onchain === null || received < least : received < due) {
      return null;
    }
  } else if (received === 0n || received >= due) {
    return null;
  }
  return { status, due, point: { hour: point.hour, rate: point.rate }, ...base };
}

/** How long the sale of a link of version 3 lasts: its start is its end less this (the app's). */
const V3_SALE_SECONDS = 600;

/**
 * A payload of version 4 (the link as published, or a final version of it), checked as the payer's
 * page checks it; null for anything else. With `pointOfSale`, version 3 too: the links the
 * merchant's points of sale make (no start, no redirection: a sale of 10 minutes until its end).
 */
export function parseLinkPayload(
  value: unknown,
  { pointOfSale = false }: { pointOfSale?: boolean } = {}
): LinkSale | null {
  if (!isObject(value)) return null;
  const v3 = pointOfSale && value.version === 3;
  if (value.version !== LINK_VERSION && !v3) return null;
  const p = value;
  const fiat = fiatOf(p.fiat);
  const address =
    p.onchainAddress === null
      ? null
      : isDepositAddress(p.onchainAddress)
        ? p.onchainAddress
        : undefined;
  if (!fiat || address === undefined) return null;
  if (!isFilledText(p.businessName, MAX_LINK_TEXT) || !isText(p.note, MAX_LINK_TEXT)) return null;
  if (typeof p.lightningAddress !== "string" || lightningAddressUrl(p.lightningAddress) === null) {
    return null;
  }
  const { endsAt } = p;
  if (v3 && (p.startsAt !== undefined || p.redirectUrl !== undefined)) return null;
  const startsAt = v3 && isPositiveSafe(endsAt) ? endsAt - V3_SALE_SECONDS : p.startsAt;
  if (!isPositiveSafe(startsAt) || !isPositiveSafe(endsAt) || startsAt >= endsAt) return null;
  if (endsAt - startsAt > MAX_SALE_SECONDS) return null;
  let redirectUrl: string | null = null;
  if (p.redirectUrl !== undefined) {
    if (!isRedirectUrl(p.redirectUrl) || p.redirectUrl.length > MAX_REDIRECT_URL) return null;
    redirectUrl = p.redirectUrl;
  }
  if (!isHex32(p.registryKey) || !isHex32(p.registryReader) || !isHex32(p.owner)) return null;
  let final: SaleFinal | null = null;
  if (p.final !== undefined) {
    final = parseSaleFinal(p.final, fiat, address);
    if (final === null) return null;
  }
  return {
    businessName: p.businessName,
    lightningAddress: p.lightningAddress,
    fiat,
    note: p.note,
    onchainAddress: address,
    startsAt,
    endsAt,
    redirectUrl,
    registryKey: p.registryKey,
    registryReader: p.registryReader,
    owner: p.owner,
    taker: typeof p.taker === "string" && /^[0-9a-f]{32}$/.test(p.taker) ? p.taker : null,
    bitcoinNode: recordNodeOf(p.bitcoinNode),
    final
  };
}
