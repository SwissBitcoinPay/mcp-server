import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { deriveKey } from "../../vendor/checkout-node/src/derive.js";
import { publicKeyOf } from "../../vendor/checkout-node/src/nostr/event.js";

import { ASSISTANT_SALT, COUNTER_SALT, MEMBER_SALT, TAKER_SALT } from "./constants.js";

/*
 * The keys an assistant key gives (SPEC.md §4), as the merchant's app derives them
 * (deriveAssistantKeys): an employee's keys from the assistant's own secret, its mark, and the keys
 * of its own invoices. HKDF-SHA256, 32 bytes; never changed.
 */

/** A secp256k1 secret and its BIP-340 x-only public key (hex). */
export type Signer = { secretKey: Uint8Array; publicKey: string };

export type AssistantKeys = {
  member: {
    /** Signs the used addresses' record; answers the channel's and the lot's reads (NIP-42). */
    nostr: Signer;
    channel: { address: string; encryptionKey: Uint8Array };
    records: { encryptionKey: Uint8Array; addressKey: Uint8Array };
    /** Signs the links' records. */
    links: Signer;
  };
  /** Marks the declarations of its sales (the taker tag): « Par » names the assistant. */
  takerKey: Uint8Array;
  invoices: { nostr: Signer; encryptionKey: Uint8Array; addressKey: Uint8Array };
  /**
   * The merchant's grant of the transactions' export to the assistant (SPEC.md §20): the NIP-44
   * key and the key of the `d` tags of its records, which the team signs.
   */
  exportGrant: { encryptionKey: Uint8Array; addressKey: Uint8Array };
};

function signer(secretKey: Uint8Array): Signer {
  return { secretKey, publicKey: publicKeyOf(secretKey) };
}

export function deriveAssistantKeys(key: Uint8Array): AssistantKeys {
  if (key.length !== 32) throw new Error("An assistant key has 32 bytes");
  const member = (info: string) => deriveKey(key, MEMBER_SALT, info);
  const own = (info: string) => deriveKey(key, ASSISTANT_SALT, info);
  return {
    member: {
      nostr: signer(member("nostr-secret-key/v1")),
      channel: {
        address: bytesToHex(member("channel/address/v1")),
        encryptionKey: member("channel/encryption-key/v1")
      },
      records: {
        encryptionKey: member("records/encryption-key/v1"),
        addressKey: member("records/address-key/v1")
      },
      links: signer(member("links/nostr-secret-key/v1"))
    },
    takerKey: deriveKey(key, TAKER_SALT, "member/v1"),
    invoices: {
      nostr: signer(own("invoices/author/v1")),
      encryptionKey: own("invoices/encryption-key/v1"),
      addressKey: own("invoices/address-key/v1")
    },
    exportGrant: {
      encryptionKey: own("export/encryption-key/v1"),
      addressKey: own("export/address-key/v1")
    }
  };
}

/** The `d` tag of the member's record about `subject`. */
export function recordAddress(keys: AssistantKeys, subject: string): string {
  return bytesToHex(hmac(sha256, keys.member.records.addressKey, utf8ToBytes(subject)));
}

/** The `d` tag of the lot the owner gave the assistant (signed by the team). */
export function lotAddress(keys: AssistantKeys): string {
  return recordAddress(keys, "onchain-lot");
}

/** The `d` tag of the addresses the assistant used. */
export function usedAddress(keys: AssistantKeys): string {
  return recordAddress(keys, "onchain-used");
}

/** The `d` tag of the record of the link whose author is `author` (hex). */
export function linkRecordAddress(keys: AssistantKeys, author: string): string {
  return recordAddress(keys, `link:${author}`);
}

/** The `d` tag of invoice `id`. */
export function invoiceAddress(keys: AssistantKeys, id: string): string {
  return invoiceAddressOf(keys.invoices.addressKey, id);
}

/** The `d` tag of invoice `id` of the invoices whose address key is `addressKey`. */
export function invoiceAddressOf(addressKey: Uint8Array, id: string): string {
  return bytesToHex(hmac(sha256, addressKey, utf8ToBytes(`invoice/${id}`)));
}

/** The keys of the shared counter, from the channel's counter key (SPEC.md §6). */
export function counterKeys(counterKey: Uint8Array): {
  encryptionKey: Uint8Array;
  address: string;
} {
  if (counterKey.length !== 32) throw new Error("A counter key has 32 bytes");
  return {
    encryptionKey: deriveKey(counterKey, COUNTER_SALT, "encryption-key/v1"),
    address: bytesToHex(deriveKey(counterKey, COUNTER_SALT, "address/v1"))
  };
}
