/*
 * Numbers and dates of the export (SPEC.md §20), written as the merchant's app writes them
 * (src/lib/locale/format.ts, date.ts and src/features/wallet/export/describe.ts of the app): with
 * Intl, in the locale of the merchant's device, never rounded (amounts are integers to the end).
 * The app formats dates in its device's own time zone; the assistant names that time zone to
 * Intl. The same engine's locale data writes the same text: the vectors (vectors/app/export.json)
 * were made with Node 22.22.2's ICU, the version this server runs.
 */

const SATS_PER_BTC = 100_000_000n;

/** A number format of `locale`, the engine's default locale when `locale` is not a valid tag. */
function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(locale, options);
  } catch {
    return new Intl.NumberFormat(undefined, options);
  }
}

const decimals = new Map<string, string>();

/** The locale's decimal separator: "," in fr-CH, "." in de-CH. */
export function decimalSeparator(locale: string): string {
  let separator = decimals.get(locale);
  if (separator === undefined) {
    const format = numberFormat(locale, { minimumFractionDigits: 1 });
    const part = format.formatToParts(1.5).find(({ type }) => type === "decimal");
    separator = part ? part.value : format.format(1.5).replace(/\d/g, "") || ".";
    decimals.set(locale, separator);
  }
  return separator;
}

/** A whole number with the locale's grouping; a bigint past Number's exact range as it is. */
export function formatInteger(value: number | bigint, locale: string): string {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      return value.toString();
    }
    value = Number(value);
  }
  return numberFormat(locale, { maximumFractionDigits: 0, useGrouping: true }).format(value);
}

/** A whole number of at least `digits` digits, zero-padded, without grouping, in the locale's digits. */
function paddedInteger(value: number, digits: number, locale: string): string {
  return numberFormat(locale, {
    minimumIntegerDigits: digits,
    maximumFractionDigits: 0,
    useGrouping: false
  }).format(value);
}

/** Minor units of `digits` decimals, plain: ASCII digits, no grouping, "-" when negative. */
export function plainMinor(minor: bigint, digits: number, separator: string): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const scale = 10n ** BigInt(digits);
  const whole = (abs / scale).toString();
  const fraction =
    digits > 0 ? `${separator}${(abs % scale).toString().padStart(digits, "0")}` : "";
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/** Sats as BTC, plain (plainMinor): « 0,00150000 », « -0,00002000 ». */
export function plainBtc(sats: bigint, separator: string): string {
  return plainMinor(sats, 8, separator);
}

/** The sign of an amount to read: U+2212 when negative, « + » when signed and above 0. */
function signOf(negative: boolean, signed: boolean, abs: bigint): string {
  return negative ? "−" : signed && abs > 0n ? "+" : "";
}

/** Sats as BTC to read (« +0,00150000 BTC »), its whole part grouped by the locale. */
export function btcText(sats: bigint, locale: string, signed: boolean): string {
  const negative = sats < 0n;
  const abs = negative ? -sats : sats;
  const whole = formatInteger(abs / SATS_PER_BTC, locale);
  const fraction = (abs % SATS_PER_BTC).toString().padStart(8, "0");
  return `${signOf(negative, signed, abs)}${whole}${decimalSeparator(locale)}${fraction} BTC`;
}

/** Minor units to read (« +1 234,50 CHF », « −12,00 CHF »), grouped. */
export function fiatText(
  minor: bigint,
  digits: number,
  currency: string,
  locale: string,
  signed: boolean
): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  // As the app: through Number, exact far beyond any amount of a wallet.
  const value = Number(abs);
  const scale = 10 ** digits;
  const whole = formatInteger(Math.floor(value / scale), locale);
  const text =
    digits === 0
      ? whole
      : `${whole}${decimalSeparator(locale)}${paddedInteger(value % scale, digits, locale)}`;
  return `${signOf(negative, signed, abs)}${text} ${currency}`;
}

/**
 * `date` written in `locale` and `timeZone` with `options`; the engine's default locale when
 * `locale` is not a valid tag, as the app falls back.
 */
export function formatDate(
  date: Date,
  locale: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions
): string {
  for (const tag of [locale, undefined]) {
    try {
      return new Intl.DateTimeFormat(tag, { ...options, timeZone }).format(date);
    } catch {
      // The next locale.
    }
  }
  return date.toISOString();
}

/** Whether `timeZone` is one Intl knows. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The decimals of a currency (Intl's), from 0 to 4, else 2: as the app's currencyDigits. */
export function currencyDigits(currency: string): number {
  try {
    const digits = new Intl.NumberFormat("en", {
      style: "currency",
      currency
    }).resolvedOptions().maximumFractionDigits;
    return digits !== undefined && Number.isInteger(digits) && digits >= 0 && digits <= 4
      ? digits
      : 2;
  } catch {
    return 2;
  }
}
