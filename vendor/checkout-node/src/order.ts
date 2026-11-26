import { redirectShown } from "./checkout.js";
import { InvalidOptionError, InvalidOrderError } from "./errors.js";
import { decodeBolt11 } from "./lightning/bolt11.js";
import type { LightningInvoice } from "./lnurl.js";
import { isDepositAddress } from "./onchain/address.js";
import {
  DEFAULT_DURATION_SECONDS,
  MAX_DURATION_SECONDS,
  MAX_NOTE_LENGTH,
  MAX_SATS,
  MIN_DURATION_SECONDS,
  REF_PATTERN,
  REF_RULE
} from "./protocol.js";
import {
  DEFAULT_RATE_SOURCES,
  RATE_SOURCES,
  parseFiat,
  rateSourceList,
  type RateSource
} from "./rates.js";
import { codePointLength, hasControlCharacter, isHex32, isObject, isWellFormed } from "./text.js";
import { parseHttpsUrl } from "./urls.js";
import type { Fiat, InvoiceToCheck } from "./types.js";

/*
 * What a caller gives, checked before any request (SPEC.md, "Creating an invoice"): an order,
 * a stored invoice, an option. Refused, never repaired.
 */

/** An order: its reference, and its amount in sats or in a currency. */
export type Order = {
  /** The order's reference, 1 to 64 characters `A–Z a–z 0–9 . _ : -`: one order, one sale. */
  ref: string;
  /** The amount in sats: a string of digits, a bigint or a safe integer; 21 million BTC at most. */
  sats?: string | bigint | number;
  /** Or the price in a currency, converted at the rate of `rateSource`: `{ amount: "24.50", currency: "CHF" }`. */
  fiat?: { amount: string; currency: string };
  /**
   * The rate source for this invoice (`fiat` only), or a list of them asked in order; the client's
   * `rateSource` by default.
   */
  rateSource?: RateSource | readonly RateSource[];
  /** Seconds the invoice can be paid: 60 to 3600, 900 by default. */
  durationSeconds?: number;
  /** What the merchant's app shows, 100 characters at most; the reference by default. */
  note?: string;
  /**
   * A checkout link: a URL of the merchant's web app where the customer pays the invoice
   * (`checkoutUrl` of the Invoice). False by default.
   */
  checkout?: boolean;
  /**
   * With `checkout` only: where the checkout link sends the customer once the invoice is paid,
   * an https URL or an app's link (`myshop://order/42`). Not a proof of payment.
   */
  redirectUrl?: string | null;
};

export type CheckedOrder = {
  ref: string;
  /** Exactly one of `sats` and `fiat`. */
  sats: bigint | null;
  fiat: Fiat | null;
  /** The rate sources of an order in a currency, in the order they are asked; null in sats. */
  rateSources: readonly RateSource[] | null;
  durationSeconds: number;
  /** The note, else the reference: what the declaration and the invoice's comment carry. */
  label: string;
  checkout: boolean;
  /** With `checkout` only: the redirect URL, else null. */
  redirectUrl: string | null;
};

export const RATE_SOURCE_RULE = `${RATE_SOURCES.map((name) => `"${name}"`).join(", ")} or a function, or a non-empty list of them without the same name twice`;

/**
 * The client's `rateSource` option, checked (SPEC.md §26): the sources it names, in the order they
 * are asked; DEFAULT_RATE_SOURCES when it is absent. InvalidOptionError (`rateSource`) otherwise.
 */
export function rateSourceOption(value: unknown): readonly RateSource[] {
  const sources = value === undefined ? DEFAULT_RATE_SOURCES : rateSourceList(value);
  if (!sources) throw new InvalidOptionError("rateSource", RATE_SOURCE_RULE);
  return sources;
}

/** `ref`, checked: InvalidOrderError (`ref`) unless it is 1 to 64 characters of REF_PATTERN. */
export function checkRef(ref: unknown): string {
  // A string only: every order without one would otherwise be one sale (`sale/undefined/v1`).
  if (typeof ref !== "string" || !REF_PATTERN.test(ref))
    throw new InvalidOrderError("ref", REF_RULE);
  return ref;
}

/**
 * The order's parameters, checked. `clientRateSources` are the client's: an order in a currency
 * without its own `rateSource` uses them.
 */
export function checkOrder(order: Order, clientRateSources: readonly RateSource[]): CheckedOrder {
  if (!isObject(order)) {
    throw new InvalidOrderError("order", "expected { ref, sats | fiat, durationSeconds?, note? }");
  }
  const ref = checkRef(order.ref);
  if ((order.sats === undefined) === (order.fiat === undefined)) {
    throw new InvalidOrderError("sats", "give either sats or fiat");
  }
  const sats = order.sats === undefined ? null : checkSats(order.sats);
  const fiat = order.fiat === undefined ? null : parseFiat(order.fiat);

  let rateSources: readonly RateSource[] | null = null;
  if (order.rateSource !== undefined) {
    if (!fiat) {
      throw new InvalidOrderError("rateSource", "only for an order priced in a currency (fiat)");
    }
    rateSources = rateSourceList(order.rateSource);
    if (!rateSources) throw new InvalidOrderError("rateSource", RATE_SOURCE_RULE);
  } else if (fiat) {
    rateSources = clientRateSources;
  }

  const durationSeconds =
    order.durationSeconds === undefined ? DEFAULT_DURATION_SECONDS : order.durationSeconds;
  if (
    !Number.isInteger(durationSeconds) ||
    durationSeconds < MIN_DURATION_SECONDS ||
    durationSeconds > MAX_DURATION_SECONDS
  ) {
    throw new InvalidOrderError(
      "durationSeconds",
      `${MIN_DURATION_SECONDS} to ${MAX_DURATION_SECONDS} seconds`
    );
  }
  const label = labelOf(order.note, ref);
  const { checkout, redirectUrl } = checkoutOf(order);
  return { ref, sats, fiat, rateSources, durationSeconds, label, checkout, redirectUrl };
}

/** `checkout` (a boolean) and `redirectUrl` (with `checkout` only, a redirect URL). */
function checkoutOf(order: Order): { checkout: boolean; redirectUrl: string | null } {
  if (order.checkout !== undefined && typeof order.checkout !== "boolean") {
    throw new InvalidOrderError("checkout", "true or false");
  }
  const checkout = order.checkout ?? false;
  if (order.redirectUrl === undefined || order.redirectUrl === null) {
    return { checkout, redirectUrl: null };
  }
  if (!checkout) {
    throw new InvalidOrderError("redirectUrl", "only with checkout: true");
  }
  if (redirectShown(order.redirectUrl) === null) {
    throw new InvalidOrderError(
      "redirectUrl",
      "an https URL (lowercase host, no user name nor password) or an app's link " +
        "(scheme://…), 2048 characters at most, without spaces nor other characters to escape"
    );
  }
  return { checkout, redirectUrl: order.redirectUrl };
}

/** Sats: a string of 1 to 18 digits, a bigint or a safe integer, from 1 to 21 million BTC. */
function checkSats(value: unknown): bigint {
  // Not BigInt(…) on anything: it takes true for 1n and "0x10" for 16n.
  const sats =
    typeof value === "bigint"
      ? value
      : (typeof value === "number" && Number.isSafeInteger(value)) ||
          (typeof value === "string" && /^[0-9]{1,18}$/.test(value))
        ? BigInt(value)
        : null;
  if (sats === null || sats < 1n || sats > MAX_SATS) {
    throw new InvalidOrderError("sats", `a whole number of sats, from 1 to ${MAX_SATS}`);
  }
  return sats;
}

/**
 * The note, without the spaces (U+0020) around it, else the reference: 100 code points at most,
 * well-formed, without control characters.
 */
function labelOf(note: unknown, ref: string): string {
  if (note === undefined) return ref;
  if (typeof note !== "string") throw new InvalidOrderError("note", "a string");
  if (hasControlCharacter(note)) throw new InvalidOrderError("note", "no control characters");
  if (!isWellFormed(note)) throw new InvalidOrderError("note", "well-formed Unicode");
  const label = note.replace(/^ +| +$/g, "") || ref;
  if (codePointLength(label) > MAX_NOTE_LENGTH) {
    throw new InvalidOrderError("note", `${MAX_NOTE_LENGTH} characters at most`);
  }
  return label;
}

/** A stored invoice, checked: what its payment check asks. */
export type StoredInvoice = {
  /** Its order's reference, with an address (null without one). */
  ref: string | null;
  /** Its Lightning invoice, null for an order paid on-chain only. */
  lightning: LightningInvoice | null;
  onchainAddress: string | null;
  sats: bigint;
  expiresAt: number;
};

const NOT_STORED = "not an invoice made by createInvoice";

/**
 * A stored invoice, checked (SPEC.md, "Payment check"): its sats and end; a mainnet invoice of
 * exactly its sats, its own payment hash and end, an https verify URL, or none of the three; a
 * deposit address, or none (absent: none); at least one of the two. With an
 * address, its reference: the witnesses of its payment are its order's. Throws InvalidOrderError
 * (`invoice`).
 */
export function checkStoredInvoice(invoice: InvoiceToCheck): StoredInvoice {
  if (!isObject(invoice)) throw new InvalidOrderError("invoice", NOT_STORED);
  const { bolt11, paymentHash, verifyUrl, expiresAt } = invoice;
  const sats =
    typeof invoice.sats === "string" && /^[0-9]{1,16}$/.test(invoice.sats)
      ? BigInt(invoice.sats)
      : null;
  if (sats === null || sats < 1n || sats > MAX_SATS || !Number.isSafeInteger(expiresAt)) {
    throw new InvalidOrderError("invoice", NOT_STORED);
  }
  let lightning: LightningInvoice | null = null;
  if (bolt11 === null) {
    if (paymentHash !== null || verifyUrl !== null) {
      throw new InvalidOrderError("invoice", NOT_STORED);
    }
  } else {
    const decoded = typeof bolt11 === "string" ? decodeBolt11(bolt11) : null;
    if (
      !decoded ||
      decoded.network !== "bc" ||
      decoded.amountMsat !== sats * 1000n ||
      !isHex32(paymentHash) ||
      decoded.paymentHash !== paymentHash ||
      decoded.timestamp + decoded.expirySeconds !== expiresAt ||
      !parseHttpsUrl(verifyUrl)
    ) {
      throw new InvalidOrderError("invoice", NOT_STORED);
    }
    lightning = { bolt11: bolt11, paymentHash, verifyUrl: verifyUrl!, expiresAt };
  }
  const address = invoice.onchainAddress ?? null;
  if (address !== null && !isDepositAddress(address)) {
    throw new InvalidOrderError("invoice", NOT_STORED);
  }
  if (lightning === null && address === null) throw new InvalidOrderError("invoice", NOT_STORED);
  let ref: string | null = null;
  if (address !== null) {
    if (typeof invoice.ref !== "string" || !REF_PATTERN.test(invoice.ref)) {
      throw new InvalidOrderError(
        "invoice",
        `${NOT_STORED}: with an address, its ref (${REF_RULE})`
      );
    }
    ref = invoice.ref;
  }
  return { ref, lightning, onchainAddress: address, sats, expiresAt };
}

/** A whole number of milliseconds within [min, max], `fallback` when undefined. */
export function checkMilliseconds(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  name: string
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new InvalidOptionError(name, `a whole number of milliseconds, ${min} to ${max}`);
  }
  return value;
}
