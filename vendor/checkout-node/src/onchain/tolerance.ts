import { MAX_TOLERANCE, TOLERANCE_SCALE } from "../protocol.js";

/*
 * The merchant's tolerance of on-chain underpayments (SPEC.md, "The merchant's tolerance"): the
 * share of an order's amount its payment in time may miss and still pay it, in basis points. The
 * channel gives it, an order's lease keeps the one of its creation: every check of the order judges
 * its payment with that one, as the merchant's app does. It is never written where the shop's page
 * or the customer reads (the Invoice, the PaymentStatus, a checkout link's record, an error, a
 * log): a customer who knew it could pay that much less on purpose.
 */

/** A tolerance as a channel or a lease writes it: an integer from 0 to MAX_TOLERANCE, else 0. */
export function toleranceOf(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_TOLERANCE
    ? value
    : 0;
}

/**
 * The least accepted of `sats` with `tolerance` (basis points): `sats` less the share the
 * tolerance allows, rounded down to the whole sat, so that the merchant never accepts more missing
 * than its tolerance. On integers.
 */
export function leastAccepted(sats: bigint, tolerance: number): bigint {
  return sats - (sats * BigInt(toleranceOf(tolerance))) / TOLERANCE_SCALE;
}

/**
 * What is due on-chain of an invoice of `sats` with `tolerance`, its rest invoices having paid
 * `paidByRests`, with the `received` of the merchant's acceptance that counts, `merchantAccepted`
 * (null without one: merchant-acceptance.ts) (SPEC.md, "The on-chain payment", step 4): nothing (0)
 * when they paid `sats` or more; else max(1, min(L, M) − R), L the least accepted, M the merchant's
 * acceptance's `received` (`sats` without one), R what they paid. R is taken once from the lesser:
 * M counts the rest invoices paid when the merchant accepted, as L counts every payment. At least 1
 * sat: something must count on-chain for the tolerance or the merchant's acceptance to apply.
 */
export function dueOnchain(
  sats: bigint,
  tolerance: number,
  paidByRests: bigint,
  merchantAccepted: bigint | null = null
): bigint {
  if (paidByRests >= sats) return 0n;
  const least = leastAccepted(sats, tolerance);
  const accepted = merchantAccepted !== null && merchantAccepted < least ? merchantAccepted : least;
  const due = accepted - paidByRests;
  return due > 0n ? due : 1n;
}
