/**
 * Bech32 decoding (BIP-173), without the 90-character limit: BOLT11 invoices are longer. Ported
 * from the merchant's app. Bech32m (BIP-350), for taproot addresses, differs by its checksum's
 * constant alone.
 */

import { asciiLower } from "../text.js";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i]!;
  }
  return chk >>> 0;
}

function expandHrp(hrp: string): number[] {
  const high: number[] = [];
  const low: number[] = [];
  for (let i = 0; i < hrp.length; i++) {
    const code = hrp.charCodeAt(i);
    high.push(code >> 5);
    low.push(code & 31);
  }
  return [...high, 0, ...low];
}

/** The checksum's constant: BIP-173's bech32, BIP-350's bech32m. */
export const BECH32 = 1;
export const BECH32M = 0x2bc830a3;

export type Bech32 = {
  /** Human-readable part, lowercase. */
  hrp: string;
  /** 5-bit words, checksum removed. */
  words: number[];
};

/**
 * Decodes a bech32 string (either case, never mixed), or null when it is not valid bech32 (or
 * bech32m, with `constant` BECH32M).
 */
export function decodeBech32(input: string, constant: number = BECH32): Bech32 | null {
  // US-ASCII characters 33 to 126 alone (BIP-173), and their ASCII case: Unicode's would read the
  // Kelvin sign (U+212A) as a k.
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code < 33 || code > 126) return null;
  }
  if (/[a-z]/.test(input) && /[A-Z]/.test(input)) return null;
  const text = asciiLower(input);
  const separator = text.lastIndexOf("1");
  if (separator < 1 || separator + 7 > text.length) return null;
  const hrp = text.slice(0, separator);
  const values: number[] = [];
  for (const char of text.slice(separator + 1)) {
    const value = CHARSET.indexOf(char);
    if (value === -1) return null;
    values.push(value);
  }
  if (polymod([...expandHrp(hrp), ...values]) !== constant) return null;
  return { hrp, words: values.slice(0, -6) };
}

/** Regroups 5-bit words into bytes; the trailing padding bits (fewer than 8) are dropped. */
export function wordsToBytes(words: readonly number[]): Uint8Array {
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const word of words) {
    accumulator = ((accumulator << 5) | word) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/** Big-endian unsigned integer of 5-bit words. */
export function wordsToInteger(words: readonly number[]): number {
  let value = 0;
  for (const word of words) value = value * 32 + word;
  return value;
}
