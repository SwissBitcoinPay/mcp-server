import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import { publicKeyOf } from "./nostr/event.js";
import { conversationKey } from "./nostr/nip44.js";
import {
  ACCEPTANCE_ADDRESS_INFO,
  CHECKOUT_SALT,
  CHANNEL_ADDRESS_INFO,
  CHANNEL_ENCRYPTION_INFO,
  DECLARATION_SALT,
  INTEGRATION_SALT,
  KEY_BYTES,
  LOT_ADDRESS_INFO,
  REST_ENCRYPTION_INFO,
  SALE_NOSTR_SECRET_INFO,
  SALE_SALT,
  SEEN_ADDRESS_KEY_INFO,
  SEEN_SECRET_INFO,
  TAKER_INFO,
  TAKER_TAG_BYTES,
  merchantAcceptanceInfo,
  outerInfo,
  restAddressInfo,
  restKeyInfo,
  restSecretInfo,
  saleInfo
} from "./protocol.js";

/*
 * The keys an integration's server derives (SPEC.md, "Key derivations"), HKDF-SHA256
 * (RFC 5869), 32 bytes, salt and info in UTF-8. They never change: the integration's channel, its
 * sales and their declarations derive from them, in the merchant's app as here (the tests check
 * them against the app's vectors, spec/vectors/app/app.json).
 */

/** HKDF-SHA256 of `secret`, 32 bytes. */
export function deriveKey(secret: Uint8Array, salt: string, info: string): Uint8Array {
  return hkdf(sha256, secret, utf8ToBytes(salt), utf8ToBytes(info), KEY_BYTES);
}

/** The integration's channel: its `d` tag (hex) and its NIP-44 conversation key. */
export function channelKeys(integrationKey: Uint8Array) {
  return {
    address: bytesToHex(deriveKey(integrationKey, INTEGRATION_SALT, CHANNEL_ADDRESS_INFO)),
    encryptionKey: deriveKey(integrationKey, INTEGRATION_SALT, CHANNEL_ENCRYPTION_INFO)
  };
}

/** Where the integration's lot of deposit addresses is: its `d` tag (hex). */
export function lotAddress(integrationKey: Uint8Array): string {
  return bytesToHex(deriveKey(integrationKey, INTEGRATION_SALT, LOT_ADDRESS_INFO));
}

/**
 * What the integration's witnesses are made with: the seen secret (it signs them), its public key
 * (their author) and the key of their addresses and order tags. Secrets, like the integration key.
 */
export function seenKeys(integrationKey: Uint8Array) {
  const secretKey = deriveKey(integrationKey, INTEGRATION_SALT, SEEN_SECRET_INFO);
  return {
    secretKey,
    author: publicKeyOf(secretKey),
    addressKey: deriveKey(integrationKey, INTEGRATION_SALT, SEEN_ADDRESS_KEY_INFO)
  };
}

/** The key that marks the integration's declarations ("By" in the app). */
export function takerKey(integrationKey: Uint8Array): Uint8Array {
  return deriveKey(integrationKey, INTEGRATION_SALT, TAKER_INFO);
}

/** The sale of an order: its own key, its Nostr secret and public key (the declarations' author). */
export function saleKeys(integrationKey: Uint8Array, ref: string) {
  const key = deriveKey(integrationKey, INTEGRATION_SALT, saleInfo(ref));
  const secretKey = deriveKey(key, SALE_SALT, SALE_NOSTR_SECRET_INFO);
  return { key, secretKey, author: publicKeyOf(secretKey) };
}

/**
 * The keys of the rest records of the order `ref`'s invoice with the deposit address `address` and
 * the end `expiresAt` (SPEC.md, "Rest records"): the rest key (its checkout links' records carry
 * it), the rest secret (it signs the records; only the integration key derives it) and its public
 * key, the author, and the records' encryption key. Secrets but `author`.
 */
export function restKeys(
  integrationKey: Uint8Array,
  ref: string,
  address: string,
  expiresAt: number
) {
  const key = deriveKey(integrationKey, INTEGRATION_SALT, restKeyInfo(ref, address, expiresAt));
  const secretKey = deriveKey(
    integrationKey,
    INTEGRATION_SALT,
    restSecretInfo(ref, address, expiresAt)
  );
  return {
    key,
    secretKey,
    author: publicKeyOf(secretKey),
    encryptionKey: deriveKey(key, CHECKOUT_SALT, REST_ENCRYPTION_INFO)
  };
}

/** The `d` tag (hex) of the rest record of the invoice whose payment hash is `paymentHash`. */
export function restRecordAddress(restKey: Uint8Array, paymentHash: string): string {
  return bytesToHex(deriveKey(restKey, CHECKOUT_SALT, restAddressInfo(paymentHash)));
}

/**
 * The `d` tag (hex) of the acceptance record of the invoice whose rest key is `restKey` (SPEC.md,
 * "Acceptance records"): one per invoice, a newer record replaces an older one.
 */
export function acceptanceRecordAddress(restKey: Uint8Array): string {
  return bytesToHex(deriveKey(restKey, CHECKOUT_SALT, ACCEPTANCE_ADDRESS_INFO));
}

/**
 * The `d` tag (hex) of the merchant's acceptance of the invoice of the sale `saleAuthor` with the
 * deposit address `address` and the end `expiresAt` (SPEC.md, "The merchant's acceptance"): one per
 * invoice.
 */
export function merchantAcceptanceAddress(
  integrationKey: Uint8Array,
  saleAuthor: string,
  address: string,
  expiresAt: number
): string {
  return bytesToHex(
    deriveKey(
      integrationKey,
      INTEGRATION_SALT,
      merchantAcceptanceInfo(saleAuthor, address, expiresAt)
    )
  );
}

/** d(H): where the declarations of payment hash `paymentHash` (hex) are. */
export function registryAddress(registryKey: Uint8Array, paymentHash: string): string {
  return bytesToHex(hmac(sha256, registryKey, hexToBytes(paymentHash)));
}

/** The outer key of a declaration at `address` by `author` (hex). */
export function outerKey(registryKey: Uint8Array, address: string, author: string): Uint8Array {
  return deriveKey(registryKey, DECLARATION_SALT, outerInfo(address, author));
}

/** Who took a sale: the first 16 bytes of HMAC-SHA256(taker key, author), hex. */
export function takerTag(key: Uint8Array, saleAuthor: string): string {
  return bytesToHex(hmac(sha256, key, hexToBytes(saleAuthor)).slice(0, TAKER_TAG_BYTES));
}

/** The merchant's registry, as the integration's channel gives it. */
export type Registry = {
  /** The registry key (32 bytes). */
  key: Uint8Array;
  /** Hex: the public half of the merchant's reading key. */
  reader: string;
};

/**
 * Everything the sale of `ref` needs, derived once: its keys, its taker tag and the conversation
 * key (ECDH) of its declarations' inside with the merchant's reading key.
 */
export type Sale = {
  ref: string;
  key: Uint8Array;
  secretKey: Uint8Array;
  author: string;
  taker: string;
  registry: Registry;
  innerKey: Uint8Array;
};

export function saleOf(integrationKey: Uint8Array, registry: Registry, ref: string): Sale {
  const { key, secretKey, author } = saleKeys(integrationKey, ref);
  return {
    ref,
    key,
    secretKey,
    author,
    taker: takerTag(takerKey(integrationKey), author),
    registry,
    innerKey: conversationKey(secretKey, registry.reader)
  };
}
