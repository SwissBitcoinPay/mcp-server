import { bytesToHex } from "@noble/hashes/utils.js";

import { MAX_BOLT11_AMOUNT_MSAT, MAX_BOLT11_EXPIRY_WORDS } from "../protocol.js";

import { decodeBech32, wordsToBytes, wordsToInteger } from "./bech32.js";

/**
 * The fields of a BOLT11 invoice the package checks: network, amount, payment hash, description
 * hash, date and expiry. Ported from the merchant's app. The signature is not
 * verified: the payee is the LNURL server's node, which nothing here can check it against; the
 * description hash ties the invoice to the merchant's Lightning address instead.
 * Spec: https://github.com/lightning/bolts/blob/master/11-payment-encoding.md, and SPEC.md
 * ("BOLT11") for what the package adds: the first `p` and `h` fields count and the last `x`, as in
 * the app; an `x` field of more than 7 words or an amount above 21 million bitcoins makes the
 * invoice invalid.
 */
export type Bolt11 = {
  /** "bc" mainnet, "tb" testnet, "tbs" signet, "bcrt" regtest. */
  network: string;
  /** Exact amount in millisatoshi, null for an invoice without amount. */
  amountMsat: bigint | null;
  /** Unix seconds. */
  timestamp: number;
  /** Seconds after `timestamp` (3600 when the invoice does not say). */
  expirySeconds: number;
  /** Hex, 32 bytes. */
  paymentHash: string;
  /** Hex, 32 bytes; null when the invoice carries a plain description. */
  descriptionHash: string | null;
};

const HRP = /^ln(bcrt|bc|tbs|tb)(\d+)?([munp])?$/;
/** Millisatoshi per unit of the amount, by multiplier (1 BTC = 10^11 msat). */
const MSAT_PER_UNIT: Record<string, bigint> = {
  "": 100_000_000_000n,
  m: 100_000_000n,
  u: 100_000n,
  n: 100n
};

const TIMESTAMP_WORDS = 7;
/** 65-byte signature, as 5-bit words. */
const SIGNATURE_WORDS = 104;
const TAG_PAYMENT_HASH = 1;
const TAG_DESCRIPTION_HASH = 23;
const TAG_EXPIRY = 6;
/** 256 bits as 5-bit words. */
const HASH_WORDS = 52;
const DEFAULT_EXPIRY_SECONDS = 3600;

function amountMsat(digits: string | undefined, multiplier: string | undefined): bigint | null {
  if (digits === undefined) return multiplier === undefined ? null : invalidAmount();
  if (digits.length > 1 && digits.startsWith("0")) return invalidAmount();
  // Longer than any amount up to 21 million bitcoins, whatever the multiplier.
  if (digits.length > 22) return invalidAmount();
  const value = BigInt(digits);
  let msat: bigint;
  if (multiplier === "p") {
    // A pico-bitcoin is a tenth of a millisatoshi: only whole millisatoshis are valid.
    if (value % 10n !== 0n) return invalidAmount();
    msat = value / 10n;
  } else {
    msat = value * MSAT_PER_UNIT[multiplier ?? ""]!;
  }
  return msat > MAX_BOLT11_AMOUNT_MSAT ? invalidAmount() : msat;
}

function invalidAmount(): never {
  throw new Error("Invalid invoice amount");
}

/** Decodes a BOLT11 invoice, or null when invalid. */
export function decodeBolt11(input: string): Bolt11 | null {
  const decoded = decodeBech32(input);
  if (!decoded) return null;
  const hrp = HRP.exec(decoded.hrp);
  if (!hrp) return null;
  let amount: bigint | null;
  try {
    amount = amountMsat(hrp[2], hrp[3]);
  } catch {
    return null;
  }
  const words = decoded.words;
  if (words.length < TIMESTAMP_WORDS + SIGNATURE_WORDS) return null;
  const timestamp = wordsToInteger(words.slice(0, TIMESTAMP_WORDS));
  const fields = words.slice(TIMESTAMP_WORDS, words.length - SIGNATURE_WORDS);

  let paymentHash: string | null = null;
  let descriptionHash: string | null = null;
  let expirySeconds: number | null = null;
  let i = 0;
  while (i < fields.length) {
    if (i + 3 > fields.length) return null;
    const tag = fields[i]!;
    const length = fields[i + 1]! * 32 + fields[i + 2]!;
    const data = fields.slice(i + 3, i + 3 + length);
    if (data.length !== length) return null;
    // Fields of an unexpected length are skipped, as the spec requires for p and h; the first of
    // each counts, and the last x (as the app reads them).
    if (tag === TAG_PAYMENT_HASH && length === HASH_WORDS && paymentHash === null) {
      paymentHash = bytesToHex(wordsToBytes(data));
    } else if (tag === TAG_DESCRIPTION_HASH && length === HASH_WORDS && descriptionHash === null) {
      descriptionHash = bytesToHex(wordsToBytes(data));
    } else if (tag === TAG_EXPIRY) {
      if (length > MAX_BOLT11_EXPIRY_WORDS) return null;
      expirySeconds = wordsToInteger(data);
    }
    i += 3 + length;
  }
  if (paymentHash === null) return null;

  return {
    network: hrp[1]!,
    amountMsat: amount,
    timestamp,
    expirySeconds: expirySeconds ?? DEFAULT_EXPIRY_SECONDS,
    paymentHash,
    descriptionHash
  };
}
