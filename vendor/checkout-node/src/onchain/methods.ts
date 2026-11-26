import { InvalidOrderError, OnchainUnavailableError, type SattlemeError } from "../errors.js";
import { ONCHAIN_FLOOR_SATS } from "../protocol.js";

/*
 * The methods of an order by its amount (SPEC.md, "Methods by amount"): Lightning when the amount
 * is within the Lightning address's sendable sats, on-chain from 1 000 sats when an address can be
 * leased. Nothing is repaired: an amount is never split between the two, nor moved into the
 * sendable sats.
 */

export type Methods = { lightning: boolean; onchain: boolean };

/**
 * The methods `sats` may be paid with, before an address is leased. InvalidOrderError (`param`:
 * "sats" or "fiat") below 1 000 sats and outside the sendable sats.
 */
export function paymentMethods(
  sats: bigint,
  sendable: { min: bigint; max: bigint },
  param: "sats" | "fiat"
): Methods {
  const lightning = sats >= sendable.min && sats <= sendable.max;
  const onchain = sats >= ONCHAIN_FLOOR_SATS;
  if (!lightning && !onchain) {
    throw new InvalidOrderError(
      param,
      `${sats} sats is outside the merchant's bounds (${sendable.min} to ${sendable.max} sats)`
    );
  }
  return { lightning, onchain };
}

/** What leasing an address gave: one, none, or the explorer's failure. */
export type LeaseOutcome =
  { status: "leased" } | { status: "none" } | { status: "explorer_failed"; error: SattlemeError };

/**
 * The methods once leasing an address gave `outcome`: without an address, Lightning only; an
 * order that can only be paid on-chain then fails with OnchainUnavailableError, or the explorer's
 * NetworkError.
 */
export function methodsWith(methods: Methods, outcome: LeaseOutcome): Methods {
  if (!methods.onchain || outcome.status === "leased") return methods;
  if (!methods.lightning) {
    throw outcome.status === "explorer_failed" ? outcome.error : new OnchainUnavailableError();
  }
  return { lightning: true, onchain: false };
}
