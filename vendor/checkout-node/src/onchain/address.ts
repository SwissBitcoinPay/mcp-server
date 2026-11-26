import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { BECH32M, decodeBech32 } from "../lightning/bech32.js";
import { LEASE_ADDRESS_PREFIX, SATS_PER_BTC } from "../protocol.js";

/*
 * Deposit addresses (SPEC.md, "Deposit addresses", "Payment URIs"): the taproot addresses the
 * merchant's wallet hands out, in their one spelling, and what the shop's page shows of an
 * invoice as one QR code.
 */

/** `bc1p` and 58 more characters. */
const DEPOSIT_ADDRESS_LENGTH = 62;
/** The witness version (1) and the 32-byte program, as 5-bit words. */
const PROGRAM_WORDS = 53;

/**
 * Whether `value` is a deposit address: the bech32m encoding (BIP-350) of the human-readable part
 * `bc`, witness version 1 and a 32-byte program (BIP-341), in lowercase. Another network, witness
 * version or length, bech32 instead of bech32m, upper case or a padding with bits that are not
 * zero is not one.
 */
export function isDepositAddress(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length !== DEPOSIT_ADDRESS_LENGTH ||
    !/^bc1[02-9ac-hj-np-z]+$/.test(value)
  ) {
    return false;
  }
  const decoded = decodeBech32(value, BECH32M);
  if (!decoded || decoded.hrp !== "bc") return false;
  const { words } = decoded;
  // 52 words after the version: 256 bits of program and 4 bits of padding, which are zeros.
  return words.length === PROGRAM_WORDS && words[0] === 1 && (words.at(-1)! & 0b1111) === 0;
}

/** Where the leases of `address` are in the registry: HMAC(registry key, "onchain/v1/" + address). */
export function leaseAddress(registryKey: Uint8Array, address: string): string {
  return bytesToHex(hmac(sha256, registryKey, utf8ToBytes(LEASE_ADDRESS_PREFIX + address)));
}

/**
 * `sats` in bitcoins, exact, as BIP-21's `amount`: no trailing zero in the fraction, no fraction
 * when whole (49 000 sats is "0.00049", 100 000 000 sats is "1").
 */
export function btcAmount(sats: bigint): string {
  const whole = sats / SATS_PER_BTC;
  const fraction = (sats % SATS_PER_BTC).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

/**
 * What the shop's page shows as one QR code: `bitcoin:<address>?amount=<BTC>`, with
 * `&lightning=<invoice>` when there is one (BIP-21, the "unified QR" wallets read), or
 * `lightning:<invoice>` without an address. Both are written as they are (lowercase).
 */
export function paymentUri(address: string | null, sats: bigint, bolt11: string | null): string {
  if (address === null) return `lightning:${bolt11}`;
  const uri = `bitcoin:${address}?amount=${btcAmount(sats)}`;
  return bolt11 === null ? uri : `${uri}&lightning=${bolt11}`;
}
