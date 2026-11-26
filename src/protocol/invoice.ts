import type { NostrEvent } from "../../vendor/checkout-node/src/nostr/event.js";
import { NewerRecordError } from "../../vendor/checkout-node/src/nostr/record.js";
import type { RandomBytes } from "../../vendor/checkout-node/src/random.js";
import { parseRelayList } from "../../vendor/checkout-node/src/relays.js";

import { isPayable, isValidLine, type InvoiceLine } from "./amounts.js";
import {
  INVOICE_BLOCK,
  INVOICE_TYPE,
  INVOICE_VERSION,
  MAX_CURRENCY_DIGITS,
  MAX_INVOICE_TEXT,
  MAX_LINES,
  MAX_LINK_URL,
  MAX_RECIPIENT_FIELD,
  MAX_REDIRECT_URL
} from "./constants.js";
import { isCalendarDate } from "./dates.js";
import { invoiceAddress, type AssistantKeys } from "./keys.js";
import { sealRecordIn } from "./record.js";
import { isFilledText, isHex32, isObject, isText, isUnixSeconds } from "./text.js";

/*
 * An invoice (SPEC.md §7): the record the merchant's app reads among its own, « Par » naming the
 * assistant. An assistant makes sent invoices only; the app ignores an assistant's drafts. Read as
 * the app reads it (src/lib/invoice/record.ts, parseInvoice): every member checked.
 */

export type InvoiceNumber = { year: number; sequence: number };

export type InvoiceRecipient = {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** The client's reference, "" when none. */
  reference: string;
};

export type InvoiceLink = {
  /** Hex: the link's author. */
  id: string;
  /** Hex: the sale key. */
  key: string;
  relays: string[];
  url: string;
};

export type Invoice = {
  version: typeof INVOICE_VERSION;
  id: string;
  number: InvoiceNumber;
  status: "sent";
  recipient: InvoiceRecipient;
  currency: { code: string; digits: number };
  lines: InvoiceLine[];
  dueDate: string;
  dueAt: number;
  terms: string;
  legal: string;
  redirectUrl: string | null;
  createdAt: number;
  updatedAt: number;
  sent: { at: number; link: InvoiceLink };
};

const ID = /^[0-9a-f]{32}$/;
const COUNTRY = /^[A-Z]{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

/** « 2026-0042 »: the year, then the rank in four digits at least. */
export function formatInvoiceNumber(number: InvoiceNumber): string {
  return `${number.year}-${String(number.sequence).padStart(4, "0")}`;
}

/** An https URL of at most MAX_REDIRECT_URL code units, with a host (WHATWG URL, as the app). */
export function isRedirectUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_REDIRECT_URL) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "";
  } catch {
    return false;
  }
}

export function isRecipient(value: unknown): value is InvoiceRecipient {
  if (!isObject(value)) return false;
  return (
    isFilledText(value.name, MAX_RECIPIENT_FIELD) &&
    isFilledText(value.street, MAX_RECIPIENT_FIELD) &&
    isFilledText(value.postalCode, MAX_RECIPIENT_FIELD) &&
    isFilledText(value.city, MAX_RECIPIENT_FIELD) &&
    isText(value.reference, MAX_RECIPIENT_FIELD) &&
    typeof value.country === "string" &&
    COUNTRY.test(value.country)
  );
}

function parseNumber(value: unknown): InvoiceNumber | null {
  if (!isObject(value)) return null;
  const { year, sequence } = value;
  if (!Number.isSafeInteger(year) || (year as number) < 2000 || (year as number) > 9999) {
    return null;
  }
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) return null;
  return { year: year as number, sequence: sequence as number };
}

function parseLine(value: unknown, digits: number): InvoiceLine | null {
  if (!isObject(value)) return null;
  const { name, quantity, unitMinor, vatRate } = value;
  if (typeof name !== "string" || typeof quantity !== "number") return null;
  if (typeof unitMinor !== "number" || typeof vatRate !== "number") return null;
  const line = { name, quantity, unitMinor, vatRate };
  return isValidLine(line, digits) ? line : null;
}

function parseLink(value: unknown): InvoiceLink | null {
  if (!isObject(value)) return null;
  const relays = parseRelayList(value.relays);
  const { id, key, url } = value;
  if (!isHex32(id) || !isHex32(key) || relays === null) return null;
  if (typeof url !== "string" || !url.startsWith("https://") || url.length > MAX_LINK_URL) {
    return null;
  }
  return { id, key, relays, url };
}

/**
 * A sent invoice's value; null for anything else (a draft, a removed draft, an invalid value).
 * Throws NewerRecordError for a newer version.
 */
export function parseInvoice(value: unknown): Invoice | null {
  if (!isObject(value)) return null;
  const v = value;
  if (typeof v.version === "number" && v.version > INVOICE_VERSION) throw new NewerRecordError();
  if (v.version !== INVOICE_VERSION || v.status !== "sent" || v.removed !== undefined) return null;
  const currency = v.currency;
  if (!isObject(currency) || typeof currency.code !== "string" || !CURRENCY.test(currency.code)) {
    return null;
  }
  const digits = currency.digits;
  if (
    !Number.isInteger(digits) ||
    (digits as number) < 0 ||
    (digits as number) > MAX_CURRENCY_DIGITS
  ) {
    return null;
  }
  if (typeof v.id !== "string" || !ID.test(v.id)) return null;
  if (!Array.isArray(v.lines) || v.lines.length > MAX_LINES) return null;
  if (!isText(v.terms, MAX_INVOICE_TEXT) || !isText(v.legal, MAX_INVOICE_TEXT)) return null;
  if (!(v.redirectUrl === null || isRedirectUrl(v.redirectUrl))) return null;
  if (!isUnixSeconds(v.createdAt) || !isUnixSeconds(v.updatedAt) || v.updatedAt < v.createdAt) {
    return null;
  }
  const number = parseNumber(v.number);
  if (!number || !isRecipient(v.recipient)) return null;
  const lines = (v.lines as unknown[]).map((line) => parseLine(line, digits as number));
  if (lines.some((line) => line === null)) return null;
  const valid = lines as InvoiceLine[];
  if (!isCalendarDate(v.dueDate) || !isUnixSeconds(v.dueAt) || v.dueAt <= 0) return null;
  const sent = v.sent;
  if (!isObject(sent) || !isUnixSeconds(sent.at) || v.dueAt <= sent.at) return null;
  const link = parseLink(sent.link);
  if (!link || !isPayable(valid, digits as number)) return null;
  const r = v.recipient;
  return {
    version: INVOICE_VERSION,
    id: v.id,
    number,
    status: "sent",
    recipient: {
      name: r.name,
      street: r.street,
      postalCode: r.postalCode,
      city: r.city,
      country: r.country,
      reference: r.reference
    },
    currency: { code: currency.code, digits: digits as number },
    lines: valid,
    dueDate: v.dueDate,
    dueAt: v.dueAt,
    terms: v.terms,
    legal: v.legal,
    redirectUrl: v.redirectUrl,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    sent: { at: sent.at, link }
  };
}

/** The signed record of `invoice`, dated by its `updatedAt`. */
export function invoiceEvent(
  keys: AssistantKeys,
  invoice: Invoice,
  random?: RandomBytes
): NostrEvent {
  return sealRecordIn({
    type: INVOICE_TYPE,
    value: invoice,
    signer: keys.invoices.nostr.secretKey,
    encryptionKey: keys.invoices.encryptionKey,
    address: invoiceAddress(keys, invoice.id),
    createdAt: invoice.updatedAt,
    block: INVOICE_BLOCK,
    ...(random ? { random } : {})
  });
}
