import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

import { base64UrlToBytes, bytesToBase64Url } from "../../vendor/checkout-node/src/encoding.js";
import { secureRandomBytes, type RandomBytes } from "../../vendor/checkout-node/src/random.js";

/*
 * What the hosted server gives out instead of keeping it (SPEC.md §16, §17): its registered
 * clients, consent requests, authorization codes and tokens are sealed values, AES-256-GCM under a
 * key of the server's secret and of their purpose, which only this server opens. A value of one
 * purpose never opens as another's (the purpose is in the key and the associated data), and each
 * says until when it holds. The server keeps no key nor client, so a restart or a second instance
 * loses nothing; changing the secret ends every token and client at once.
 */

export type Purpose = "client" | "consent" | "code" | "access" | "refresh" | "pdf" | "export";

const VERSION = 1;
const SALT = "sattle.me/mcp-hosted";

export class Sealer {
  readonly #keys = new Map<Purpose, Uint8Array>();
  readonly #random: RandomBytes;

  /** `secret`: 32 bytes at least, from the server's configuration. */
  constructor(secret: Uint8Array, random: RandomBytes = secureRandomBytes) {
    if (secret.length < 32) throw new Error("The sealing secret needs 32 bytes at least");
    for (const purpose of [
      "client",
      "consent",
      "code",
      "access",
      "refresh",
      "pdf",
      "export"
    ] as const) {
      this.#keys.set(
        purpose,
        hkdf(sha256, secret, utf8ToBytes(SALT), utf8ToBytes(`${purpose}/v1`), 32)
      );
    }
    this.#random = random;
  }

  /** `value` sealed for `purpose` until `expiresAt` (Unix seconds). */
  seal(purpose: Purpose, value: object, expiresAt: number): string {
    const nonce = this.#random(12);
    const plain = utf8ToBytes(JSON.stringify({ v: value, exp: expiresAt }));
    const sealed = gcm(this.#keys.get(purpose)!, nonce, utf8ToBytes(purpose)).encrypt(plain);
    const out = new Uint8Array(1 + nonce.length + sealed.length);
    out[0] = VERSION;
    out.set(nonce, 1);
    out.set(sealed, 13);
    return bytesToBase64Url(out);
  }

  /**
   * The value sealed for `purpose`, if `text` is one and still holds at `now`; null otherwise (any
   * other text, another purpose, altered, expired).
   */
  open(purpose: Purpose, text: unknown, now: number): Record<string, unknown> | null {
    if (typeof text !== "string" || text.length > 8192) return null;
    const bytes = base64UrlToBytes(text);
    if (!bytes || bytes.length < 1 + 12 + 16 || bytes[0] !== VERSION) return null;
    let plain: Uint8Array;
    try {
      plain = gcm(this.#keys.get(purpose)!, bytes.subarray(1, 13), utf8ToBytes(purpose)).decrypt(
        bytes.subarray(13)
      );
    } catch {
      return null;
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
    } catch {
      return null;
    }
    if (typeof envelope !== "object" || envelope === null) return null;
    const { v, exp } = envelope as { v?: unknown; exp?: unknown };
    if (typeof exp !== "number" || !Number.isSafeInteger(exp) || exp <= now) return null;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    return v as Record<string, unknown>;
  }
}
