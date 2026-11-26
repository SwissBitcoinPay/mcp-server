import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import { InvalidInvoiceError, NetworkError } from "./errors.js";
import { getJson, hostOf, type HttpOptions } from "./http.js";
import { decodeBolt11, type Bolt11 } from "./lightning/bolt11.js";
import { CLOCK_TOLERANCE_SECONDS, GRACE_SECONDS, NOT_FOUND_REASON } from "./protocol.js";
import { asciiLower, isObject, isWellFormed, trimAscii, utf8Length } from "./text.js";
import { parseHttpsUrl, sameHost } from "./urls.js";
import type { LightningPart } from "./onchain/payment.js";

/*
 * The merchant's Lightning address (LUD-16, LUD-06, LUD-12, LUD-21), as the merchant's point of
 * sale uses it: plain HTTPS requests
 * to the merchant's LNURL server (breez.tips), which makes invoices for the merchant's wallet even
 * while it is offline (SPEC.md, "Lightning address", "Payment check").
 */

type Json = Record<string, unknown>;

type LnurlAnswer = { json: Json } | { refusal: string };

/** An LNURL error answer (LUD-06): `{"status": "ERROR", "reason": …}` (any case). */
function isServiceError(body: unknown): body is Json {
  return isObject(body) && typeof body.status === "string" && asciiLower(body.status) === "error";
}

/**
 * An LNURL answer: a JSON object, or the service's refusal (`{"status": "ERROR"}`), sent with a
 * 200 or a client error status (400 "amount out of range"…). A server error (5xx), a timeout (408),
 * a rate limit (429) or anything that is not a JSON object is no answer: NetworkError.
 */
async function lnurlGet(url: string, http: HttpOptions): Promise<LnurlAnswer> {
  const { status, ok, body } = await getJson(url, http);
  const refusalStatus = status >= 400 && status < 500 && status !== 408 && status !== 429;
  if ((ok || refusalStatus) && isServiceError(body)) {
    return { refusal: typeof body.reason === "string" ? body.reason : "" };
  }
  if (!ok || !isObject(body)) {
    throw new NetworkError(`${hostOf(url)} answered HTTP ${status} without an LNURL answer`);
  }
  return { json: body };
}

/** Millisatoshis of a JSON number: a non-negative safe integer, else null. */
function msat(value: unknown): bigint | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? BigInt(value)
    : null;
}

const LIGHTNING_ADDRESS = /^([a-z0-9\-_.+]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/;

/**
 * LUD-16: the LNURL-pay endpoint of a Lightning address (ASCII whitespace around it removed, ASCII
 * letters lowered, as the app reads it), or null when it is not one. The endpoint is an https URL
 * (SPEC.md, "Lightning address"): its domain is never an IP address, nor `localhost`.
 */
export function lightningAddressUrl(address: string): string | null {
  const match = LIGHTNING_ADDRESS.exec(asciiLower(trimAscii(address)));
  if (!match) return null;
  const url = `https://${match[2]}/.well-known/lnurlp/${match[1]}`;
  return parseHttpsUrl(url) ? url : null;
}

/** The LNURL-pay parameters of the merchant's Lightning address. */
export type PayRequest = {
  /** An https URL (SPEC.md, "HTTP"). */
  callback: string;
  minSendableMsat: bigint;
  maxSendableMsat: bigint;
  /** The raw metadata: the invoices' description hash is its SHA-256 (LUD-06). */
  metadata: string;
  /** Longest comment accepted (LUD-12), 0 when none. */
  commentAllowed: number;
};

/** Reads the LNURL-pay parameters of a Lightning address (LUD-16). */
export async function fetchPayRequest(address: string, http: HttpOptions): Promise<PayRequest> {
  const url = lightningAddressUrl(address);
  if (!url) throw new InvalidInvoiceError("The merchant's Lightning address is invalid");
  const answer = await lnurlGet(url, http);
  if ("refusal" in answer) {
    throw new NetworkError(`${hostOf(url)} refused the Lightning address: ${answer.refusal}`);
  }
  const { json } = answer;
  const { callback } = json;
  const min = msat(json.minSendable);
  const max = msat(json.maxSendable);
  if (
    json.tag !== "payRequest" ||
    typeof callback !== "string" ||
    !parseHttpsUrl(callback) ||
    min === null ||
    max === null ||
    min > max ||
    typeof json.metadata !== "string" ||
    // A lone surrogate (an escape in the JSON) has no UTF-8 to hash (SPEC.md §6, §16).
    !isWellFormed(json.metadata)
  ) {
    throw new InvalidInvoiceError(`${hostOf(url)} gave no valid LNURL-pay request`);
  }
  const commentAllowed =
    typeof json.commentAllowed === "number" && Number.isSafeInteger(json.commentAllowed)
      ? Math.max(0, json.commentAllowed)
      : 0;
  return {
    callback,
    minSendableMsat: min,
    maxSendableMsat: max,
    metadata: json.metadata,
    commentAllowed
  };
}

/** The description hash of the invoices of `pay` (hex): SHA-256 of its metadata's UTF-8 (LUD-06). */
export function descriptionHashOf(pay: PayRequest): string {
  return bytesToHex(sha256(utf8ToBytes(pay.metadata)));
}

/**
 * Whole sats the Lightning address accepts: its millisatoshi bounds rounded inwards (the minimum up,
 * the maximum down), so that a whole-sat amount within them is within the service's.
 */
export function sendableSats(pay: PayRequest): { min: bigint; max: bigint } {
  return { min: (pay.minSendableMsat + 999n) / 1000n, max: pay.maxSendableMsat / 1000n };
}

/** What the Lightning address answered: an invoice and its LUD-21 verify URL, not checked yet. */
export type InvoiceAnswer = { pr: string; verify: string };

/**
 * Asks the Lightning address for an invoice of `sats` (LUD-06): `amount` in millisatoshis,
 * `expiry` in seconds (breez.tips honours it to the second), and `comment` only when its UTF-8
 * bytes fit `commentAllowed` (LUD-12 does not say how a comment's length counts: bytes are never
 * fewer than characters, so the service never refuses it). The callback's own query parameters are
 * kept, its fragment dropped (the parameters would come after it, and never reach the server). The
 * answer is not checked: checkInvoice does.
 */
export async function requestInvoice(
  pay: PayRequest,
  { sats, expirySeconds, comment }: { sats: bigint; expirySeconds: number; comment?: string },
  http: HttpOptions
): Promise<InvoiceAnswer> {
  let url: URL;
  try {
    url = new URL(pay.callback);
  } catch (error) {
    // An https URL whose host fetch cannot read either (a punycode label that decodes to nothing,
    // `xn--abc.example`): no answer.
    throw new NetworkError("The Lightning address's callback cannot be asked", { cause: error });
  }
  url.hash = "";
  url.searchParams.set("amount", (sats * 1000n).toString());
  url.searchParams.set("expiry", String(expirySeconds));
  if (comment && utf8Length(comment) <= pay.commentAllowed)
    url.searchParams.set("comment", comment);
  const answer = await lnurlGet(url.toString(), http);
  if ("refusal" in answer) {
    throw new NetworkError(`The Lightning address refused the invoice: ${answer.refusal}`);
  }
  const { pr, verify } = answer.json;
  if (typeof pr !== "string" || typeof verify !== "string") {
    throw new InvalidInvoiceError(
      "The Lightning address gave no invoice or no verify URL (LUD-21)"
    );
  }
  return { pr, verify };
}

/** What an invoice must be (checkInvoice). */
export type InvoiceExpectation = {
  pay: PayRequest;
  sats: bigint;
  /** Seconds asked: its expiry may not be longer. */
  durationSeconds: number;
  /** Unix seconds: the server's clock. */
  now: number;
};

/**
 * Checks an invoice before it is declared or shown (SPEC.md, "Invoice checks"):
 * Bitcoin mainnet, exactly `sats`, the merchant's description hash (breez.tips serves the invoices
 * of all its users), a verify URL in https on the callback's host, an expiry no longer than asked,
 * a date within 5 minutes of the clock, time left before its end. Throws InvalidInvoiceError
 * naming the first check failed.
 */
export function checkInvoice(answer: InvoiceAnswer, expected: InvoiceExpectation): Bolt11 {
  const decoded = decodeBolt11(answer.pr);
  if (!decoded) throw new InvalidInvoiceError("Not a BOLT11 invoice");
  if (decoded.network !== "bc") throw new InvalidInvoiceError("Not a Bitcoin mainnet invoice");
  if (decoded.amountMsat !== expected.sats * 1000n) {
    throw new InvalidInvoiceError("The invoice's amount differs from the order's");
  }
  if (decoded.descriptionHash !== descriptionHashOf(expected.pay)) {
    throw new InvalidInvoiceError("The invoice does not pay the merchant's Lightning address");
  }
  const verify = parseHttpsUrl(answer.verify);
  if (!verify || !sameHost(verify, parseHttpsUrl(expected.pay.callback)!)) {
    throw new InvalidInvoiceError("No verify URL (LUD-21) on the Lightning address's host");
  }
  if (decoded.expirySeconds > expected.durationSeconds) {
    throw new InvalidInvoiceError("The invoice lasts longer than asked");
  }
  if (decoded.expirySeconds <= 0) throw new InvalidInvoiceError("The invoice has no time left");
  if (Math.abs(decoded.timestamp - expected.now) > CLOCK_TOLERANCE_SECONDS) {
    throw new InvalidInvoiceError("The invoice's date is too far from this server's clock");
  }
  // Dated up to 5 minutes back, a short invoice may already be over: never declared nor shown.
  if (decoded.timestamp + decoded.expirySeconds <= expected.now) {
    throw new InvalidInvoiceError("The invoice has no time left");
  }
  return decoded;
}

/** What the Lightning part of a payment check needs of an invoice. */
export type LightningInvoice = {
  bolt11: string;
  paymentHash: string;
  verifyUrl: string;
  expiresAt: number;
};

/**
 * The Lightning part of an invoice's payment (LUD-21), checked: the verify answer names this very invoice (`pr`,
 * whatever the case of its ASCII letters), `settled` is true and the preimage's SHA-256 is the payment hash. After the
 * invoice's end plus GRACE_SECONDS, "not settled" and "Not found" are final (`expired`); before, any
 * refusal of the service keeps it `open`. Throws NetworkError when the service gives no answer (or
 * another refusal past the grace: breez.tips sometimes answers "Internal server error" with a
 * 200), InvalidInvoiceError when its answer is about another invoice or its preimage is wrong.
 */
export async function verifyPayment(
  invoice: LightningInvoice,
  http: HttpOptions,
  now: number
): Promise<LightningPart> {
  const final = now >= invoice.expiresAt + GRACE_SECONDS;
  const answer = await lnurlGet(invoice.verifyUrl, http);
  if ("refusal" in answer) {
    if (!final) return { state: "open" };
    if (answer.refusal === NOT_FOUND_REASON) return { state: "expired" };
    throw new NetworkError(`The payment check was refused: ${answer.refusal}`);
  }
  const { pr, settled, preimage } = answer.json;
  if (typeof pr !== "string") {
    throw new InvalidInvoiceError("The payment check names no invoice (LUD-21 pr)");
  }
  // BOLT11 is case-insensitive (bech32): the same invoice may be written in upper case.
  if (asciiLower(pr) !== asciiLower(invoice.bolt11)) {
    throw new InvalidInvoiceError("The payment check is about another invoice");
  }
  if (settled !== true) {
    return final ? { state: "expired" } : { state: "open" };
  }
  if (typeof preimage !== "string" || !/^[0-9a-f]{64}$/i.test(preimage)) {
    throw new InvalidInvoiceError("Paid without a valid preimage");
  }
  const proof = preimage.toLowerCase();
  if (bytesToHex(sha256(hexToBytes(proof))) !== invoice.paymentHash) {
    throw new InvalidInvoiceError("The preimage does not match the payment hash");
  }
  return { state: "paid", preimage: proof };
}
