/**
 * BOLT11 invoices built for tests, so that a test chooses their fields. The signature is 65 zero
 * bytes: nothing verifies it.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i]!;
  }
  return chk >>> 0;
}

function expandHrp(hrp: string): number[] {
  const codes = [...hrp].map((c) => c.charCodeAt(0));
  return [...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31)];
}

function encodeBech32(hrp: string, words: number[]): string {
  const mod = polymod([...expandHrp(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join("")}`;
}

function bytesToWords(bytes: Uint8Array): number[] {
  const words: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((accumulator >> bits) & 31);
    }
  }
  if (bits > 0) words.push((accumulator << (5 - bits)) & 31);
  return words;
}

function integerWords(value: number, length?: number): number[] {
  const words: number[] = [];
  let rest = value;
  do {
    words.unshift(rest % 32);
    rest = Math.floor(rest / 32);
  } while (rest > 0);
  while (length !== undefined && words.length < length) words.unshift(0);
  return words;
}

function field(tag: number, data: number[]): number[] {
  return [tag, Math.floor(data.length / 32), data.length % 32, ...data];
}

/** A 32-byte preimage made of `seed`, and its payment hash, hex. */
export function preimagePair(seed: number): { preimage: string; paymentHash: string } {
  const preimage = new Uint8Array(32).fill(seed & 0xff);
  return { preimage: bytesToHex(preimage), paymentHash: bytesToHex(sha256(preimage)) };
}

export function metadataHash(metadata: string): string {
  return bytesToHex(sha256(utf8ToBytes(metadata)));
}

function amountPart(msat: bigint): string {
  if (msat % 100_000_000_000n === 0n) return `${msat / 100_000_000_000n}`;
  if (msat % 100_000_000n === 0n) return `${msat / 100_000_000n}m`;
  if (msat % 100_000n === 0n) return `${msat / 100_000n}u`;
  if (msat % 100n === 0n) return `${msat / 100n}n`;
  return `${msat * 10n}p`;
}

export function makeInvoice({
  amountMsat,
  network = "bc",
  paymentHash,
  descriptionHash,
  timestamp,
  expirySeconds,
  extra = []
}: {
  amountMsat?: bigint;
  network?: string;
  paymentHash: string;
  descriptionHash?: string;
  timestamp: number;
  expirySeconds?: number;
  /** More tagged fields, after the others: [tag, 5-bit words]. */
  extra?: [number, number[]][];
}): string {
  const hrp = `ln${network}${amountMsat === undefined ? "" : amountPart(amountMsat)}`;
  const words = [
    ...integerWords(timestamp, 7),
    ...field(1, bytesToWords(hexToBytes(paymentHash))),
    ...(descriptionHash ? field(23, bytesToWords(hexToBytes(descriptionHash))) : []),
    ...(expirySeconds !== undefined ? field(6, integerWords(expirySeconds)) : []),
    ...extra.flatMap(([tag, data]) => field(tag, data)),
    ...new Array<number>(104).fill(0)
  ];
  return encodeBech32(hrp, words);
}
