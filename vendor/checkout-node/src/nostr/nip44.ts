import { chacha20 } from "@noble/ciphers/chacha.js";
import { equalBytes } from "@noble/ciphers/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import { base64ToBytes, bytesToBase64 } from "../encoding.js";
import { secureRandomBytes, type RandomBytes } from "../random.js";
import { decodeUtf8, isHex32 } from "../text.js";

/*
 * NIP-44 version 2 (https://github.com/nostr-protocol/nips/blob/master/44.md), as the merchant's
 * app implements it: ChaCha20, HMAC-SHA256 over the nonce and the ciphertext, per-message keys
 * from a random 32-byte nonce, plaintext padded. Checked against the spec's test vectors
 * (test/nip44.test.ts). The conversation key is a 32-byte HKDF output used as is, except inside a
 * registry declaration: the spec's ECDH (conversationKey).
 */

const VERSION = 2;
const MIN_PLAINTEXT = 1;
const MAX_PLAINTEXT = 0xffff;

/** A payload of another NIP-44 version: written by a newer client. */
export class UnknownNip44VersionError extends Error {
  constructor() {
    super("NIP-44 payload of an unknown version");
    this.name = "UnknownNip44VersionError";
  }
}

/**
 * The spec's conversation key of two parties (`get_conversation_key`): the x coordinate of the
 * ECDH of `secretKey` with the x-only public key `publicKey` (hex), through HKDF-extract with the
 * salt "nip44-v2". Throws for a key out of range or off the curve.
 */
export function conversationKey(secretKey: Uint8Array, publicKey: string): Uint8Array {
  if (!isHex32(publicKey)) throw new Error("Invalid public key");
  const shared = secp256k1.getSharedSecret(secretKey, hexToBytes(`02${publicKey}`));
  return extract(sha256, shared.subarray(1, 33), utf8ToBytes("nip44-v2"));
}

/** The spec's padded length of a plaintext of `length` bytes (`calc_padded_len`). */
export function paddedLength(length: number): number {
  if (length <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(length - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((length - 1) / chunk) + 1);
}

/** `get_message_keys`: the ChaCha20 key and nonce and the HMAC key of one message. */
export function messageKeys(conversationKey: Uint8Array, nonce: Uint8Array) {
  if (conversationKey.length !== 32) throw new Error("Invalid conversation key length");
  if (nonce.length !== 32) throw new Error("Invalid nonce length");
  const keys = expand(sha256, conversationKey, nonce, 76);
  return {
    chachaKey: keys.subarray(0, 32),
    chachaNonce: keys.subarray(32, 44),
    hmacKey: keys.subarray(44, 76)
  };
}

function pad(text: string): Uint8Array {
  const bytes = utf8ToBytes(text);
  if (bytes.length < MIN_PLAINTEXT || bytes.length > MAX_PLAINTEXT) {
    throw new Error("Invalid plaintext length");
  }
  const padded = new Uint8Array(2 + paddedLength(bytes.length));
  new DataView(padded.buffer).setUint16(0, bytes.length);
  padded.set(bytes, 2);
  return padded;
}

function unpad(padded: Uint8Array): string {
  const length = new DataView(padded.buffer, padded.byteOffset).getUint16(0);
  if (length < MIN_PLAINTEXT || padded.length !== 2 + paddedLength(length)) {
    throw new Error("Invalid padding");
  }
  const text = decodeUtf8(padded.subarray(2, 2 + length));
  if (text === null) throw new Error("Invalid UTF-8");
  return text;
}

function mac(hmacKey: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  return hmac(sha256, hmacKey, concatBytes(nonce, ciphertext));
}

/** Encrypts `text` under `conversationKey` (32 bytes), with a fresh random nonce. */
export function nip44Encrypt(
  text: string,
  conversationKey: Uint8Array,
  random: RandomBytes = secureRandomBytes
): string {
  return nip44EncryptWithNonce(text, conversationKey, random(32));
}

/** nip44Encrypt with a given nonce: for the spec's test vectors only. */
export function nip44EncryptWithNonce(
  text: string,
  conversationKey: Uint8Array,
  nonce: Uint8Array
): string {
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(conversationKey, nonce);
  const ciphertext = chacha20(chachaKey, chachaNonce, pad(text));
  return bytesToBase64(
    concatBytes(new Uint8Array([VERSION]), nonce, ciphertext, mac(hmacKey, nonce, ciphertext))
  );
}

/**
 * The text of a NIP-44 v2 payload. Throws UnknownNip44VersionError for another version, another
 * error when the payload is malformed or not sealed with `conversationKey`.
 */
export function nip44Decrypt(payload: string, conversationKey: Uint8Array): string {
  if (payload.length === 0 || payload[0] === "#") throw new UnknownNip44VersionError();
  if (payload.length < 132 || payload.length > 87472) throw new Error("Invalid payload size");
  const data = base64ToBytes(payload);
  if (!data || data.length < 99 || data.length > 65603) throw new Error("Invalid payload");
  if (data[0] !== VERSION) throw new UnknownNip44VersionError();
  const nonce = data.subarray(1, 33);
  const ciphertext = data.subarray(33, data.length - 32);
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(conversationKey, nonce);
  // Constant time: the comparison does not stop at the first differing byte.
  if (!equalBytes(mac(hmacKey, nonce, ciphertext), data.subarray(data.length - 32))) {
    throw new Error("Invalid MAC");
  }
  return unpad(chacha20(chachaKey, chachaNonce, ciphertext));
}
