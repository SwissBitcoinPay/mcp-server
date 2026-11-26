import countries from "i18n-iso-countries";
import de from "i18n-iso-countries/langs/de.json" with { type: "json" };
import en from "i18n-iso-countries/langs/en.json" with { type: "json" };
import es from "i18n-iso-countries/langs/es.json" with { type: "json" };
import fi from "i18n-iso-countries/langs/fi.json" with { type: "json" };
import fr from "i18n-iso-countries/langs/fr.json" with { type: "json" };
import it from "i18n-iso-countries/langs/it.json" with { type: "json" };
import pt from "i18n-iso-countries/langs/pt.json" with { type: "json" };

import type { Language } from "../protocol/constants.js";
import { parseDay } from "../protocol/dates.js";

/*
 * Numbers, dates and country names on an invoice's PDF, as the merchant's app writes them
 * (src/lib/terminal/amount.ts formatFiat, src/lib/locale/format.ts, src/features/invoices/form.ts,
 * src/lib/countries.ts): amounts from their integers, never from a float; the locale's grouping and
 * separators. The locale is the invoice's language in the merchant's region (fr-CH, region.ts), as
 * the app takes its device's.
 */

for (const locale of [de, en, es, fi, fr, it, pt]) countries.registerLocale(locale);

function numberFormat(tag: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(tag, options);
  } catch {
    return new Intl.NumberFormat("en", options);
  }
}

/** The locale's decimal separator: "," in fr-CH, "." in de-CH. */
export function decimalSeparator(tag: string): string {
  const part = numberFormat(tag, { minimumFractionDigits: 1 })
    .formatToParts(1.5)
    .find(({ type }) => type === "decimal");
  return part?.value ?? ".";
}

/** An amount of `minor` minor units with `digits` decimals: « 3 904,10 » in fr-CH. */
export function money(minor: number, digits: number, tag: string): string {
  const scale = 10 ** digits;
  const major = Math.floor(minor / scale);
  const whole = numberFormat(tag, { maximumFractionDigits: 0, useGrouping: true }).format(major);
  if (digits === 0) return whole;
  const fraction = numberFormat(tag, {
    minimumIntegerDigits: digits,
    maximumFractionDigits: 0,
    useGrouping: false
  }).format(minor % scale);
  return `${whole}${decimalSeparator(tag)}${fraction}`;
}

/** « 3 904,10 CHF »: the currency after the amount. */
export function moneyWithCurrency(
  minor: number,
  currency: { code: string; digits: number },
  tag: string
): string {
  return `${money(minor, currency.digits, tag)} ${currency.code}`;
}

/** « 8,1% » (fr-CH), from basis points. */
export function vatLabel(rate: number, tag: string): string {
  return numberFormat(tag, { style: "percent", maximumFractionDigits: 2 }).format(rate / 10_000);
}

/** A quantity in hundredths as typed: 150 → « 1,5 », 2400 → « 24 ». */
export function quantityText(quantity: number, tag: string): string {
  const whole = Math.floor(quantity / 100);
  const fraction = String(quantity % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return fraction === "" ? String(whole) : `${whole}${decimalSeparator(tag)}${fraction}`;
}

/** A calendar date `YYYY-MM-DD` as « 03.12.2026 » in the locale (2-digit day and month). */
export function numericDate(day: string, tag: string): string {
  const parsed = parseDay(day);
  if (!parsed) return day;
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  try {
    return new Intl.DateTimeFormat(tag, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: "UTC"
    }).format(date);
  } catch {
    return day;
  }
}

/** A country's name in `language` (ISO 3166-1 alpha-2 in): its code when none is known. */
export function countryName(code: string, language: Language): string {
  return countries.getName(code, language) ?? code;
}
