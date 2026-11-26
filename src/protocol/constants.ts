/*
 * The assistant's constants (SPEC.md §18). The salts, `info` strings, record types and prefixes are
 * the merchant's app's: never change one, every assistant's records and keys derive from them.
 */

/** The beginning of an assistant's secret key (SPEC.md §3). */
export const ASSISTANT_KEY_PREFIX = "sattleme_ak_";

/** HKDF salts (SPEC.md §4). */
export const ASSISTANT_SALT = "sattle.me/assistant";
export const MEMBER_SALT = "sattle.me/team-member";
export const TAKER_SALT = "sattle.me/declaration-taker";
export const COUNTER_SALT = "sattle.me/invoice-counter";
export const SALE_ACCEPTANCE_SALT = "sattle.me/sale-acceptance";

/** Record types (SPEC.md §5 to §12, §15). */
export const CHANNEL_TYPE = "team-channel";
export const COUNTER_TYPE = "invoice-counter-shared";
export const INVOICE_TYPE = "invoice";
export const LOT_TYPE = "team-onchain-lot";
export const USED_TYPE = "team-onchain-used";
export const LINK_TYPE = "payment-link";
export const LINK_RECORD_TYPE = "team-link";
export const SALE_ACCEPTANCE_TYPE = "sale-accepted";

/** Versions of the values this assistant reads and writes. */
export const CHANNEL_VERSION = 1;
/** An assistant's channel without invoices (SPEC.md §5): format 1 without `invoicing`. */
export const NO_INVOICING_CHANNEL_VERSION = 2;
export const COUNTER_VERSION = 1;
export const INVOICE_VERSION = 1;
export const LOT_VERSION = 2;
export const LINK_VERSION = 4;
export const LINK_RECORD_VERSION = 1;
export const SALE_ACCEPTANCE_VERSION = 1;

/** An invoice's plaintext is padded to a multiple of this many bytes (SPEC.md §2). */
export const INVOICE_BLOCK = 1024;

/** Prefixes of the link's hashes (SPEC.md §11, §15). */
export const LINK_ADDRESS_PREFIX = "sattle.me/payment-link/address/v2";
export const OWNER_FINAL_PREFIX = "sattle.me/payment-link/owner-final/v1";
export const OWNER_TWEAK_PREFIX = "sattle.me/payment-link/owner/v1";

/** The payer's page of the merchant's web app (SPEC.md §11). */
export const LINK_PATH = "/pay";

/** Limits (SPEC.md §5 to §11). */
export const MAX_ASSISTANT_NAME = 40;
export const MAX_BUSINESS_NAME = 200;
export const MAX_BUSINESS_FIELD = 120;
export const MAX_BUSINESS_NUMBER = 40;
export const MAX_VAT_RATE = 10_000;
export const MAX_COUNTER_WRITERS = 64;
export const MAX_LINES = 50;
export const MAX_LINE_NAME = 120;
export const MAX_RECIPIENT_FIELD = 120;
export const MAX_INVOICE_TEXT = 1000;
export const MAX_REDIRECT_URL = 500;
export const MAX_LINK_URL = 2000;
export const MAX_LINK_TEXT = 200;
export const MAX_QUANTITY = 9_999_999;
export const MAX_MAJOR_UNITS = 99_999;
export const MAX_CURRENCY_DIGITS = 4;
export const MAX_DUE_MONTHS = 9;
/**
 * The due date of an invoice the user named none for: this many days after today (SPEC.md §7), so
 * that an invoice asked for in one message is made at once.
 */
export const DEFAULT_DUE_DAYS = 30;
export const MAX_SALE_SECONDS = 25_920_000;
/**
 * The most addresses of a lot, and of its used record, by the lot's version (SPEC.md §10): 20 in
 * version 1, 100 in version 2 (an assistant's lot).
 */
export const LOT_SIZES: Readonly<Record<number, number>> = { 1: 20, 2: 100 };
export const MAX_SEALED_KEY = 400;

/** Lightning's margin for an invoice without an address, in percent (SPEC.md §13). */
export const LIGHTNING_MARGIN_PERCENT = 20n;

/** Points of the hour (SPEC.md §9). */
export const HOUR_SECONDS = 3600;
export const POINT_DELAY_SECONDS = 300;
export const COINGECKO_URL = "https://api.coingecko.com/api/v3";
export const HOURLY_DELAY_SECONDS = 900;
export const DAY_SECONDS = 86_400;
export const HOURLY_SPAN_SECONDS = 89 * DAY_SECONDS;
export const HISTORY_DAYS = 365;

/** Following a payment (SPEC.md §15). */
export const SALE_START_TOLERANCE_SECONDS = 60;
export const UNIQUENESS_READ_LIMIT = 20;
export const MAX_FINAL_PAYMENTS = 50;
export const MEMPOOL_TIME_MARGIN_SECONDS = 300;

/** The word for invoice in a payment link's note, by language (SPEC.md §11). */
export const INVOICE_WORDS = {
  fr: "Facture",
  en: "Invoice",
  de: "Rechnung",
  it: "Fattura",
  es: "Factura",
  pt: "Fatura",
  fi: "Lasku"
} as const;

export type Language = keyof typeof INVOICE_WORDS;

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && Object.hasOwn(INVOICE_WORDS, value);
}

/**
 * The languages texts are written in: the app's, German in its two variants (the merchant's app,
 * src/i18n/languages.ts): « de » as Germany and Austria write it (ß, „ “, MwSt.), « de-CH » as
 * Switzerland and Liechtenstein do (ss, « », MWST). A call and a grant name the language only
 * (« de »): the locale's region tells the variant (SPEC.md §20, §21).
 */
export type TextLanguage = Language | "de-CH";

/** Regions that write Swiss Standard German (Rat für deutsche Rechtschreibung, § 25 E2). */
const SWISS_GERMAN_REGIONS: readonly string[] = ["CH", "LI"];

/**
 * The language texts are written in for `language` and the locale numbers are written in (a BCP 47
 * tag: « de-CH », « de_LI », « fr-CH », « de »): German in the variant of the locale's region, as
 * the app picks it from its device's.
 */
export function textLanguage(language: Language, locale: string | null | undefined): TextLanguage {
  if (language !== "de") return language;
  const [, ...rest] = (locale ?? "").split(/[-_]/);
  // The region is the first subtag of two letters after the language (a script has four).
  const region = rest.find((subtag) => /^[A-Za-z]{2}$/.test(subtag))?.toUpperCase();
  return region !== undefined && SWISS_GERMAN_REGIONS.includes(region) ? "de-CH" : "de";
}
