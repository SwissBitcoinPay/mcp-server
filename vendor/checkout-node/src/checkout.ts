import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import type { DeclaredPrice } from "./declaration.js";
import { deriveKey } from "./derive.js";
import { base64UrlToBytes, bytesToBase64Url } from "./encoding.js";
import { decodeBolt11 } from "./lightning/bolt11.js";
import { isPublicKey, publicKeyOf, type NostrEvent } from "./nostr/event.js";
import { NewerRecordError, sealRecord } from "./nostr/record.js";
import { isDepositAddress } from "./onchain/address.js";
import { recordNodeOf, type RecordNode } from "./onchain/node.js";
import {
  CHECKOUT_ADDRESS_INFO,
  CHECKOUT_ENCRYPTION_INFO,
  CHECKOUT_LIFE_SECONDS,
  CHECKOUT_MARKER,
  CHECKOUT_ONCHAIN_VERSION,
  CHECKOUT_PATH,
  CHECKOUT_RECORD_TYPE,
  CHECKOUT_SALT,
  CHECKOUT_VERSION,
  KEY_BYTES,
  MAX_BUSINESS_NAME_LENGTH,
  MAX_DECLARED_DIGITS,
  MAX_NOTE_LENGTH,
  MAX_REDIRECT_SCHEME_LENGTH,
  MAX_REDIRECT_URL_LENGTH,
  MAX_SATS,
  REFUSED_REDIRECT_SCHEMES,
  SATS_CURRENCY
} from "./protocol.js";
import type { RandomBytes } from "./random.js";
import { decodeRelayList } from "./relays.js";
import { parseHttpsUrl, URL_CHARACTERS } from "./urls.js";
import {
  codePointLength,
  hasControlCharacter,
  isHex32,
  isObject,
  isWellFormed,
  trimAscii
} from "./text.js";

/*
 * Checkout links (SPEC.md, "Checkout links"): a URL of the merchant's web app,
 * `<origin>/pay#c.<author>.<key>.<relays>`, whose page reads the invoice from the merchant's
 * relays, shows it, checks its payment from the customer's browser and, once it is paid, sends the
 * customer to the order's redirect URL. The record is sealed with a key of the link alone (in the
 * URL's fragment, which browsers never send to the web app's host) and signed by an author of the
 * link alone, whose secret is forgotten once it is published: nobody, the integrator included, can
 * change a link afterwards. The package writes links; it also reads them (fragments, records), as
 * the page does, for the conformance vectors.
 */

/** The authority of an https URL as written: its host and its port. */
const HTTPS_AUTHORITY = /^https:\/\/([^/?#]*)/;
const APP_URL = /^([a-z][a-z0-9+.-]*):\/\//;
/** The first part of a newer link's fragment: 1 to 8 characters `a–z 0–9`. */
const MARKER = /^[a-z0-9]{1,8}$/;
const RELAY_PREFIX = "wss://";

/**
 * A checkout origin: `https://`, a host as in a relay address, an optional port, nothing else.
 * What the channel's `checkout.origin` must be (SPEC.md, "The web app's origin").
 */
export function isCheckoutOrigin(value: unknown): value is string {
  return parseHttpsUrl(value) !== null && /^https:\/\/[^/?#]*$/.test(value as string);
}

/** The origin a channel's `checkout` field gives: null when it gives none or an invalid one. */
export function checkoutOriginOf(checkout: unknown): string | null {
  return isObject(checkout) && isCheckoutOrigin(checkout.origin) ? checkout.origin : null;
}

/**
 * What the page shows of a redirect URL ("Redirecting to …"): the host and port of an https
 * URL as written, the scheme and `://` of an app's link. Null when `value` is not a redirect URL
 * (SPEC.md, "Redirect URLs"): nothing is repaired.
 */
export function redirectShown(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > MAX_REDIRECT_URL_LENGTH ||
    !URL_CHARACTERS.test(value)
  ) {
    return null;
  }
  if (value.startsWith("https://")) {
    return parseHttpsUrl(value) ? HTTPS_AUTHORITY.exec(value)![1]! : null;
  }
  const app = APP_URL.exec(value);
  if (!app) return null;
  const scheme = app[1]!;
  if (
    scheme.length > MAX_REDIRECT_SCHEME_LENGTH ||
    scheme === "https" ||
    REFUSED_REDIRECT_SCHEMES.has(scheme)
  ) {
    return null;
  }
  return `${scheme}://`;
}

/** The keys of a link (its link key, 32 bytes): its `d` tag (hex) and its NIP-44 conversation key. */
export function checkoutKeys(linkKey: Uint8Array) {
  return {
    address: bytesToHex(deriveKey(linkKey, CHECKOUT_SALT, CHECKOUT_ADDRESS_INFO)),
    encryptionKey: deriveKey(linkKey, CHECKOUT_SALT, CHECKOUT_ENCRYPTION_INFO)
  };
}

/** A link author's secret: 32 random bytes, drawn again until they are a secp256k1 secret key. */
function authorSecret(random: RandomBytes): Uint8Array {
  for (;;) {
    const secret = random(KEY_BYTES);
    if (secp256k1.utils.isValidSecretKey(secret)) return secret;
  }
}

/** The relays as a fragment's part: the hosts without `wss://`, joined by `,`, in base64url. */
function encodeRelayList(relays: readonly string[]): string {
  return bytesToBase64Url(
    utf8ToBytes(relays.map((relay) => relay.slice(RELAY_PREFIX.length)).join(","))
  );
}

/** The URL of a link: `<origin>/pay#c.<author>.<key>.<relays>`. */
export function checkoutUrl(
  origin: string,
  author: string,
  linkKey: Uint8Array,
  relays: readonly string[]
): string {
  const parts = [
    CHECKOUT_MARKER,
    bytesToBase64Url(hexToBytes(author)),
    bytesToBase64Url(linkKey),
    encodeRelayList(relays)
  ];
  return `${origin}${CHECKOUT_PATH}#${parts.join(".")}`;
}

/**
 * What a link's record holds (SPEC.md, "The record"), as JSON: version 1 for an invoice without an
 * address, version 2 for one with an address (its invoice and verify URL null for an order paid
 * on-chain only).
 */
export type CheckoutValue =
  | {
      version: typeof CHECKOUT_VERSION;
      businessName: string;
      invoice: string;
      verifyUrl: string;
      /** The order's price as declared; null for an order in sats. */
      fiat: DeclaredPrice | null;
      /** The label: the note, else the reference. */
      note: string;
      redirectUrl: string | null;
    }
  | {
      version: typeof CHECKOUT_ONCHAIN_VERSION;
      businessName: string;
      invoice: string | null;
      verifyUrl: string | null;
      onchainAddress: string;
      /** The Invoice's sats, as a JSON number, and its dates: the page watches the address alone. */
      sats: number;
      createdAt: number;
      expiresAt: number;
      fiat: DeclaredPrice | null;
      note: string;
      redirectUrl: string | null;
      /**
       * The rest author and the rest key (hex) of the order and the address (SPEC.md, "Rest
       * records"): the page reads the invoices of the rest of an underpayment with them. Both or
       * neither: absent in a record made without them.
       */
      restAuthor?: string;
      restKey?: string;
      /**
       * The merchant's Bitcoin node the page reads the chain from (SPEC.md §30, §31): the
       * channel's `url` and `fallback`, copied as they are, when its `payers` is true; absent
       * otherwise. Never `payers`.
       */
      bitcoinNode?: RecordNode;
    };

/** The record of a link to an invoice: version 2 with an address, else version 1. */
export function checkoutValue(input: {
  businessName: string;
  invoice: string | null;
  verifyUrl: string | null;
  onchainAddress: string | null;
  sats: bigint;
  createdAt: number;
  expiresAt: number;
  fiat: DeclaredPrice | null;
  note: string;
  redirectUrl: string | null;
  /** With an address: its rest author and rest key (derive.ts, restKeys). */
  rest: { author: string; key: Uint8Array } | null;
  /**
   * The node the pages read, with an address (node.ts, recordNodeFor: the channel's with `payers`
   * true); null for mempool.space. Never in a record of version 1.
   */
  bitcoinNode: RecordNode | null;
}): CheckoutValue {
  const { businessName, invoice, verifyUrl, onchainAddress, fiat, note, redirectUrl } = input;
  if (onchainAddress === null) {
    return {
      version: CHECKOUT_VERSION,
      businessName,
      invoice: invoice!,
      verifyUrl: verifyUrl!,
      fiat,
      note,
      redirectUrl
    };
  }
  return {
    version: CHECKOUT_ONCHAIN_VERSION,
    businessName,
    invoice,
    verifyUrl,
    onchainAddress,
    sats: Number(input.sats),
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    fiat,
    note,
    redirectUrl,
    ...(input.rest ? { restAuthor: input.rest.author, restKey: bytesToHex(input.rest.key) } : {}),
    ...(input.bitcoinNode
      ? { bitcoinNode: { url: input.bitcoinNode.url, fallback: input.bitcoinNode.fallback } }
      : {})
  };
}

/** A new link, before it is published. */
export type NewCheckoutLink = {
  url: string;
  event: NostrEvent;
  /**
   * The author's secret: it answers the relays' authentication while the event is published,
   * then is dropped. Never stored, returned to the caller nor logged.
   */
  secretKey: Uint8Array;
};

/**
 * A new link to the invoice `value` holds, ending `expiresAt` (Unix seconds): a fresh link key
 * and author, the record signed at `createdAt`, dropped by the relays a week after the invoice's
 * end, and the URL on `origin` naming `relays` (where it is to be published).
 */
export function newCheckoutLink(input: {
  origin: string;
  relays: readonly string[];
  value: CheckoutValue;
  expiresAt: number;
  createdAt: number;
  random: RandomBytes;
}): NewCheckoutLink {
  const linkKey = input.random(KEY_BYTES);
  const secretKey = authorSecret(input.random);
  const keys = checkoutKeys(linkKey);
  const event = sealRecord({
    type: CHECKOUT_RECORD_TYPE,
    value: input.value,
    signer: secretKey,
    encryptionKey: keys.encryptionKey,
    address: keys.address,
    createdAt: input.createdAt,
    tags: [["expiration", String(input.expiresAt + CHECKOUT_LIFE_SECONDS)]],
    random: input.random
  });
  return {
    url: checkoutUrl(input.origin, publicKeyOf(secretKey), linkKey, input.relays),
    event,
    secretKey
  };
}

/** What a fragment names (SPEC.md, "Reading the fragment"). */
export type CheckoutFragment =
  | { status: "link"; author: string; linkKey: Uint8Array; relays: string[] }
  /** A link of a newer format: the page asks to be updated. */
  | { status: "newer" }
  | { status: "invalid" }
  /** Not a checkout link: another link of the page. */
  | { status: "other" };

/** The link a URL's fragment (with or without "#") names. */
export function parseCheckoutFragment(fragment: string): CheckoutFragment {
  const parts = (fragment.startsWith("#") ? fragment.slice(1) : fragment).split(".");
  const [marker, author, key, relays, ...rest] = parts;
  if (marker !== CHECKOUT_MARKER) {
    return MARKER.test(marker!) ? { status: "newer" } : { status: "other" };
  }
  if (author === undefined || key === undefined || relays === undefined || rest.length > 0) {
    return { status: "invalid" };
  }
  const authorBytes = base64UrlToBytes(author);
  const linkKey = base64UrlToBytes(key);
  const list = decodeRelayList(relays);
  if (authorBytes?.length !== KEY_BYTES || linkKey?.length !== KEY_BYTES || list === null) {
    return { status: "invalid" };
  }
  const authorHex = bytesToHex(authorBytes);
  if (!isPublicKey(authorHex)) return { status: "invalid" };
  return { status: "link", author: authorHex, linkKey, relays: list };
}

/** A link's record, checked: what the page shows. */
export type CheckoutRecord = {
  businessName: string;
  /** The Lightning invoice, null for an order paid on-chain only. */
  invoice: string | null;
  paymentHash: string | null;
  verifyUrl: string | null;
  /** The deposit address, null without one (a record of version 1). */
  onchainAddress: string | null;
  /** Whole sats: the invoice's amount, and what the address must receive. */
  sats: bigint;
  createdAt: number;
  expiresAt: number;
  fiat: DeclaredPrice | null;
  note: string;
  redirectUrl: string | null;
  /** What the page shows of `redirectUrl`. */
  redirectShown: string | null;
  /** The rest author (hex) and rest key of a record of version 2 that carries them, else null. */
  rest: { author: string; key: Uint8Array } | null;
  /**
   * The merchant's Bitcoin node the page reads the chain from, with its fallback: of a record of
   * version 2 whose `bitcoinNode` is valid; null for mempool.space (none, one set aside, or a
   * record of version 1, which ignores it).
   */
  bitcoinNode: RecordNode | null;
};

function parsePrice(value: unknown): DeclaredPrice | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  const { minor, digits, currency } = value;
  if (typeof minor !== "number" || !Number.isSafeInteger(minor) || minor < 1) return undefined;
  if (
    typeof digits !== "number" ||
    !Number.isInteger(digits) ||
    digits < 0 ||
    digits > MAX_DECLARED_DIGITS
  ) {
    return undefined;
  }
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency) || currency === SATS_CURRENCY) {
    return undefined;
  }
  return { minor, digits, currency };
}

/**
 * A record's value, checked as the page reads it (SPEC.md, "The record"): version 1 or 2. Null
 * when it is not valid; throws NewerRecordError for a newer version.
 */
export function parseCheckoutValue(value: unknown): CheckoutRecord | null {
  if (!isObject(value)) return null;
  const v = value;
  if (typeof v.version === "number" && v.version > CHECKOUT_ONCHAIN_VERSION) {
    throw new NewerRecordError();
  }
  if (v.version !== CHECKOUT_VERSION && v.version !== CHECKOUT_ONCHAIN_VERSION) return null;
  const { businessName, invoice, verifyUrl, note, redirectUrl } = v;
  if (
    typeof businessName !== "string" ||
    !isWellFormed(businessName) ||
    trimAscii(businessName) === "" ||
    codePointLength(businessName) > MAX_BUSINESS_NAME_LENGTH
  ) {
    return null;
  }
  let lightning: {
    paymentHash: string;
    sats: bigint;
    createdAt: number;
    expiresAt: number;
  } | null = null;
  if (v.version === CHECKOUT_VERSION || invoice !== null || verifyUrl !== null) {
    if (typeof invoice !== "string") return null;
    const decoded = decodeBolt11(invoice);
    if (!decoded || decoded.network !== "bc" || decoded.amountMsat === null) return null;
    if (decoded.amountMsat <= 0n || decoded.amountMsat % 1000n !== 0n) return null;
    if (typeof verifyUrl !== "string" || !parseHttpsUrl(verifyUrl)) return null;
    lightning = {
      paymentHash: decoded.paymentHash,
      sats: decoded.amountMsat / 1000n,
      createdAt: decoded.timestamp,
      expiresAt: decoded.timestamp + decoded.expirySeconds
    };
  }
  let onchainAddress: string | null = null;
  let rest: CheckoutRecord["rest"] = null;
  let bitcoinNode: RecordNode | null = null;
  /** The Invoice's sats and dates: of the record with an address, else of its BOLT11. */
  let terms: { sats: bigint; createdAt: number; expiresAt: number } | null = lightning;
  if (v.version === CHECKOUT_ONCHAIN_VERSION) {
    const { sats, createdAt, expiresAt } = v;
    if (!isDepositAddress(v.onchainAddress)) return null;
    if (typeof sats !== "number" || !Number.isSafeInteger(sats) || sats < 1) return null;
    if (BigInt(sats) > MAX_SATS) return null;
    if (
      typeof createdAt !== "number" ||
      !Number.isSafeInteger(createdAt) ||
      typeof expiresAt !== "number" ||
      !Number.isSafeInteger(expiresAt) ||
      createdAt >= expiresAt
    ) {
      return null;
    }
    if (
      lightning &&
      (lightning.sats !== BigInt(sats) ||
        lightning.createdAt !== createdAt ||
        lightning.expiresAt !== expiresAt)
    ) {
      return null;
    }
    onchainAddress = v.onchainAddress;
    terms = { sats: BigInt(sats), createdAt, expiresAt };
    if (v.restAuthor !== undefined || v.restKey !== undefined) {
      if (!isPublicKey(v.restAuthor) || !isHex32(v.restKey)) return null;
      rest = { author: v.restAuthor, key: hexToBytes(v.restKey) };
    }
    // Invalid in any way (null included), set aside: the page reads mempool.space, and the
    // record stays valid. In version 1, ignored.
    bitcoinNode = recordNodeOf(v.bitcoinNode);
  }
  const fiat = parsePrice(v.fiat);
  if (fiat === undefined) return null;
  if (
    typeof note !== "string" ||
    !isWellFormed(note) ||
    hasControlCharacter(note) ||
    codePointLength(note) < 1 ||
    codePointLength(note) > MAX_NOTE_LENGTH
  ) {
    return null;
  }
  const shown = redirectUrl === null ? null : redirectShown(redirectUrl);
  if (redirectUrl !== null && shown === null) return null;
  return {
    businessName,
    invoice: lightning ? invoice : null,
    paymentHash: lightning?.paymentHash ?? null,
    verifyUrl: lightning ? verifyUrl : null,
    onchainAddress,
    sats: terms!.sats,
    createdAt: terms!.createdAt,
    expiresAt: terms!.expiresAt,
    fiat,
    note,
    redirectUrl: redirectUrl as string | null,
    redirectShown: shown,
    rest,
    bitcoinNode
  };
}
