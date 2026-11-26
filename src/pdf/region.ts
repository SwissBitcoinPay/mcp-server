import type { Invoicing } from "../protocol/channel.js";
import type { Language } from "../protocol/constants.js";

/*
 * The merchant's region on an invoice's PDF: the region of the one who makes the invoice, never its
 * recipient's, as the merchant's app takes its device's. It decides the PDF's numbers and dates
 * (« de-CH ») and German's variant (Swiss German in Switzerland and Liechtenstein). From what the
 * merchant's own software tells, with no other service asked:
 *
 * 1. its preferred languages in the invoice's language (« de-CH » for an invoice in German): the
 *    invoice card's AI app, then the merchant's computer (local) or the browser it connected with
 *    (hosted);
 * 2. the country its app detected when the account was created (`detectedCountry`: the phone's
 *    time zone, its IP address, its region);
 * 3. the region of its other preferred languages (« fr-CH »);
 * 4. its business's country (its address).
 */

/** The language and region of a BCP 47 or POSIX locale (« de-CH », « de_CH.UTF-8 », « de-Latn-CH »). */
function parts(locale: string): { language: string; region: string | null } {
  const [language = "", ...rest] = locale.trim().split(/[.@]/)[0]!.split(/[-_]/);
  // The region is the first subtag of two letters after the language (a script has four).
  const region = rest.find((subtag) => /^[A-Za-z]{2}$/.test(subtag));
  return { language: language.toLowerCase(), region: region ? region.toUpperCase() : null };
}

/** The merchant's region for an invoice in `language`; null when nothing tells it. */
export function merchantRegion(
  language: Language,
  preferences: readonly string[],
  invoicing: Pick<Invoicing, "detectedCountry" | "businessAddress">
): string | null {
  const preferred = preferences.map(parts);
  return (
    preferred.find((locale) => locale.language === language && locale.region !== null)?.region ??
    invoicing.detectedCountry ??
    preferred.find((locale) => locale.region !== null)?.region ??
    invoicing.businessAddress?.country ??
    null
  );
}

/** At most this many preferred languages are kept (an Accept-Language may list many). */
export const MAX_PREFERENCES = 8;

/**
 * The preferred languages among `values`, from outside (a browser's Accept-Language, an AI app's
 * locale, a token): the BCP 47 tags Intl knows, of at most 35 characters, canonical, each once, at
 * most MAX_PREFERENCES; anything else is left out.
 */
export function preferredLocales(values: readonly unknown[]): string[] {
  const kept: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || value.length > 35) continue;
    let tag: string | undefined;
    try {
      tag = Intl.getCanonicalLocales(value)[0];
    } catch {
      continue;
    }
    if (tag !== undefined && !kept.includes(tag)) kept.push(tag);
    if (kept.length === MAX_PREFERENCES) break;
  }
  return kept;
}

/**
 * The languages of an Accept-Language header (RFC 9110 §12.5.4), the most preferred first: by
 * weight, then in order; « * » and weights of 0 left out.
 */
export function acceptedLanguages(header: string | undefined): string[] {
  if (!header || header.length > 1000) return [];
  const ranges = header.split(",").flatMap((part, index) => {
    const [range = "", ...params] = part.trim().split(";");
    const weight = params
      .map((param) => /^\s*q\s*=\s*([01](?:\.\d{0,3})?)\s*$/i.exec(param)?.[1])
      .find((value) => value !== undefined);
    const q = weight === undefined ? 1 : Number(weight);
    const tag = range.trim();
    return tag === "" || tag === "*" || !(q > 0) ? [] : [{ tag, q, index }];
  });
  ranges.sort((a, b) => b.q - a.q || a.index - b.index);
  return preferredLocales(ranges.map(({ tag }) => tag));
}
