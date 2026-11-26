/*
 * The invoice card's logic without the page (card.ts draws it): what the tools' answers say, read
 * as untrusted (an AI app relays them), the arguments the card sends back, and how it writes
 * amounts and dates. No arithmetic on amounts: the server computes every total, the card only
 * writes its decimal texts in the user's locale.
 */

export const LANGUAGES = ["fr", "en", "de", "it", "es", "pt", "fi"] as const;
export type Language = (typeof LANGUAGES)[number];

/** The card's languages: German in its two variants, « de-CH » as Switzerland writes it. */
export type TextLanguage = Language | "de-CH";

export type Recipient = {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  country: string;
  reference: string;
};

export const RECIPIENT_FIELDS = [
  "name",
  "street",
  "postalCode",
  "city",
  "country",
  "reference"
] as const satisfies readonly (keyof Recipient)[];

export type Line = { description: string; quantity: string; unitPrice: string; vatRate: string };

/** What the card makes the invoice from: preview_invoice's answer, or the call's arguments. */
export type Draft = {
  recipient: Recipient;
  lines: Line[];
  dueDate: string;
  terms: string;
  legal: string;
  redirectUrl: string | null;
  language: Language | null;
  timeZone: string | null;
  /** The second of the first preview: create_invoice makes the invoice once since then. */
  previewedAt: string | null;
};

/** preview_invoice's answer, as the card uses it. */
export type Preview = {
  canInvoice: boolean;
  issuer: string;
  currency: string;
  net: string;
  vat: { rate: string; base: string; vat: string }[];
  total: string;
  dueDates: { first: string; last: string } | null;
  draft: Draft;
  /** Asked with a previewedAt: the invoice like it made since, or null; undefined: not asked. */
  alreadyMade: Made | null | undefined;
};

/** An invoice made, as create_invoice (and preview_invoice's alreadyMade) tell it. */
export type Made = {
  id: string;
  number: string;
  recipient: string;
  /** « 3904.10 CHF ». */
  total: string;
  dueDate: string;
  paymentLink: string;
  alreadyMade: boolean;
};

/** A tool's error: its code, its message, what is off. */
export type Failure = {
  error: string;
  message: string;
  details: string[];
  previewedAt: string | null;
};

export type Answer = { ok: true; value: unknown } | { ok: false; failure: Failure };

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, max = 2000): string | null =>
  typeof value === "string" && value.length <= max ? value : null;

const DECIMAL = /^\d{1,15}(\.\d{1,4})?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const NUMBER = /^\d{4}-\d{4,}$/;
const ID = /^[0-9a-f]{32}$/;

const decimal = (value: unknown): string | null => {
  const t = text(value, 40);
  return t !== null && DECIMAL.test(t) ? t : null;
};

export const isLanguage = (value: unknown): value is Language =>
  typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);

/**
 * An https link as it was written (trimmed), or null. Never the URL parser's form of it: the server
 * compares the texts (a redirect URL tells an invoice like another, same.ts).
 */
export function httpsUrl(value: unknown): string | null {
  const t = text(value, 2000)?.trim();
  if (t === undefined || t === "") return null;
  try {
    const url = new URL(t);
    return url.protocol === "https:" && url.hostname !== "" ? t : null;
  } catch {
    return null;
  }
}

/** A link's host, to show where it goes, or the text itself when it is none. */
export function hostOf(link: string): string {
  try {
    return new URL(link).host || link;
  } catch {
    return link;
  }
}

/** The due dates a server's problem allows (« dueDate: from 2026-11-04 to 2027-08-03 »). */
export function dueRangeOf(problems: readonly string[]): { first: string; last: string } | null {
  for (const problem of problems) {
    const match = /^dueDate: from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})$/.exec(problem);
    if (match) return { first: match[1]!, last: match[2]! };
  }
  return null;
}

/** A tool's answer: its first text, JSON, as the server writes it (tools.ts json, failure). */
export function readAnswer(result: unknown): Answer {
  const unreadable: Answer = {
    ok: false,
    failure: { error: "unreadable", message: "", details: [], previewedAt: null }
  };
  if (!isObj(result) || !Array.isArray(result.content)) return unreadable;
  const first: unknown = result.content[0];
  if (!isObj(first) || first.type !== "text" || typeof first.text !== "string") return unreadable;
  let value: unknown;
  try {
    value = JSON.parse(first.text);
  } catch {
    return unreadable;
  }
  if (result.isError !== true) return { ok: true, value };
  if (!isObj(value)) return unreadable;
  const at = text(value.previewedAt, 40);
  return {
    ok: false,
    failure: {
      error: text(value.error, 100) ?? "unreadable",
      message: text(value.message, 1000) ?? "",
      details: Array.isArray(value.details)
        ? value.details.filter((d): d is string => typeof d === "string").slice(0, 60)
        : [],
      previewedAt: at !== null && INSTANT.test(at) ? at : null
    }
  };
}

function recipientOf(value: unknown, loose: boolean): Recipient | null {
  if (!isObj(value)) return null;
  const out = {} as Recipient;
  for (const field of RECIPIENT_FIELDS) {
    // A call's arguments may leave a field out (what the card asks for); an answer leaves out
    // only the reference.
    const absent = value[field] === undefined && (loose || field === "reference");
    const t = absent ? "" : text(value[field], 500);
    if (t === null) return null;
    out[field] = t;
  }
  return out;
}

function linesOf(value: unknown, loose: boolean): Line[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return null;
  const lines: Line[] = [];
  for (const entry of value) {
    if (!isObj(entry)) return null;
    const description = text(entry.description, 500);
    const unitPrice = loose ? text(entry.unitPrice, 40) : decimal(entry.unitPrice);
    const quantity =
      entry.quantity === undefined && loose
        ? "1"
        : loose
          ? text(entry.quantity, 40)
          : decimal(entry.quantity);
    const vatRate =
      entry.vatRate === undefined && loose
        ? ""
        : loose
          ? text(entry.vatRate, 40)
          : decimal(entry.vatRate);
    if (description === null || unitPrice === null || quantity === null || vatRate === null)
      return null;
    lines.push({ description, quantity, unitPrice, vatRate });
  }
  return lines;
}

export function readMade(value: unknown): Made | null {
  if (!isObj(value)) return null;
  const id = text(value.id, 32);
  const number = text(value.number, 20);
  const recipient = text(value.recipient, 500);
  const total = text(value.total, 60);
  const dueDate = text(value.dueDate, 10);
  const paymentLink = httpsUrl(value.paymentLink);
  if (
    id === null ||
    !ID.test(id) ||
    number === null ||
    !NUMBER.test(number) ||
    recipient === null ||
    total === null ||
    !/^\d{1,15}(\.\d{1,4})? [A-Z]{3}$/.test(total) ||
    dueDate === null ||
    !DAY.test(dueDate) ||
    paymentLink === null
  ) {
    return null;
  }
  return {
    id,
    number,
    recipient,
    total,
    dueDate,
    paymentLink,
    alreadyMade: value.alreadyMade === true
  };
}

export function readPreview(value: unknown): Preview | null {
  if (!isObj(value)) return null;
  const recipient = recipientOf(value.recipient, false);
  const lines = linesOf(value.lines, false);
  const net = decimal(value.net);
  const total = decimal(value.total);
  const currency = text(value.currency, 3);
  const issuer = text(value.issuer, 500);
  const dueDate = text(value.dueDate, 10);
  const previewedAt = text(value.previewedAt, 40);
  if (
    recipient === null ||
    lines === null ||
    net === null ||
    total === null ||
    currency === null ||
    !/^[A-Z]{3}$/.test(currency) ||
    issuer === null ||
    dueDate === null ||
    !DAY.test(dueDate) ||
    previewedAt === null ||
    !INSTANT.test(previewedAt) ||
    !Array.isArray(value.vat)
  ) {
    return null;
  }
  const vat: Preview["vat"] = [];
  for (const group of value.vat) {
    if (!isObj(group)) return null;
    const rate = decimal(group.rate);
    const base = decimal(group.base);
    const amount = decimal(group.vat);
    if (rate === null || base === null || amount === null) return null;
    vat.push({ rate, base, vat: amount });
  }
  const range = isObj(value.dueDates) ? value.dueDates : null;
  const first = text(range?.first, 10);
  const last = text(range?.last, 10);
  const made = value.alreadyMade;
  const already = made === undefined || made === null ? null : readMade(made);
  // Told made, but not readable: never « not made ».
  if (made !== undefined && made !== null && already === null) return null;
  return {
    canInvoice: value.canInvoice === true,
    issuer,
    currency,
    net,
    vat,
    total,
    dueDates:
      first !== null && last !== null && DAY.test(first) && DAY.test(last) ? { first, last } : null,
    draft: {
      recipient,
      lines,
      dueDate,
      terms: text(value.terms, 4000) ?? "",
      legal: text(value.legal, 4000) ?? "",
      redirectUrl: httpsUrl(value.redirectUrl),
      language: isLanguage(value.language) ? value.language : null,
      timeZone: text(value.timeZone, 100),
      previewedAt
    },
    // An invoice made since the preview: already made, whatever its summary says.
    alreadyMade: made === undefined ? undefined : already && { ...already, alreadyMade: true }
  };
}

/**
 * The draft of a call's arguments (preview_invoice's, when its answer is an error: what is missing
 * is completed in the card), with the second its error gave.
 */
export function draftOfArguments(args: unknown, previewedAt: string | null): Draft | null {
  if (!isObj(args)) return null;
  const recipient = recipientOf(args.recipient ?? {}, true);
  const lines = linesOf(args.lines, true);
  const terms = args.terms === undefined ? "" : text(args.terms, 4000);
  const legal = args.legal === undefined ? "" : text(args.legal, 4000);
  if (recipient === null || lines === null || terms === null || legal === null) return null;
  return {
    recipient,
    lines,
    dueDate: text(args.dueDate, 10) ?? "",
    // As the model gave them, the server's to refuse: the card never drops what it would refuse.
    terms,
    legal,
    redirectUrl: typeof args.redirectUrl === "string" ? args.redirectUrl : null,
    language: isLanguage(args.language) ? args.language : null,
    timeZone: text(args.timeZone, 100),
    previewedAt
  };
}

/** The arguments of preview_invoice and create_invoice for `draft`. */
export function argumentsOf(draft: Draft): Record<string, unknown> {
  return {
    recipient: { ...draft.recipient },
    lines: draft.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      ...(line.vatRate === "" ? {} : { vatRate: line.vatRate })
    })),
    dueDate: draft.dueDate,
    terms: draft.terms,
    legal: draft.legal,
    ...(draft.redirectUrl === null ? {} : { redirectUrl: draft.redirectUrl }),
    ...(draft.language === null ? {} : { language: draft.language }),
    ...(draft.timeZone === null ? {} : { timeZone: draft.timeZone }),
    ...(draft.previewedAt === null ? {} : { previewedAt: draft.previewedAt })
  };
}

/** The recipient's fields the user still has to fill (the server says it, the card shows where). */
export function missingFields(recipient: Recipient): (keyof Recipient)[] {
  const missing: (keyof Recipient)[] = [];
  for (const field of ["name", "street", "postalCode", "city"] as const) {
    if (recipient[field].trim() === "") missing.push(field);
  }
  if (!/^[A-Za-z]{2}$/.test(recipient.country.trim())) missing.push("country");
  return missing;
}

/**
 * The card's language: the AI app's, else the invoice's, else English. German in the variant of the
 * AI app's region: Swiss German in Switzerland and Liechtenstein (« de-CH », « de-LI »).
 */
export function languageOf(locale: string | undefined, fallback: Language | null): TextLanguage {
  const language = locale?.split(/[-_]/)[0]?.toLowerCase();
  if (!isLanguage(language)) return fallback ?? "en";
  return variantOf(language, locale);
}

/** The region of a BCP 47 tag (« de-CH », « zh-Hant-TW »); null when it names none. */
function regionOf(locale: string | undefined): string | null {
  const [, ...rest] = locale?.split(/[-_]/) ?? [];
  // The region is the first subtag of two letters after the language (a script has four).
  const region = rest.find((subtag) => /^[A-Za-z]{2}$/.test(subtag));
  return region ? region.toUpperCase() : null;
}

const swissRegion = (region: string | null) => region === "CH" || region === "LI";

/** German in the variant of `locale`'s region (« de-CH » in Switzerland and Liechtenstein). */
export function variantOf(language: Language, locale: string | undefined): TextLanguage {
  return language === "de" && swissRegion(regionOf(locale)) ? "de-CH" : language;
}

/** The languages a PDF is offered in (the app's, DocumentLanguageChip), in the app's order. */
export const TEXT_LANGUAGES: readonly TextLanguage[] = [
  "fr",
  "en",
  "de",
  "de-CH",
  "it",
  "es",
  "pt",
  "fi"
];

export const isTextLanguage = (value: unknown): value is TextLanguage =>
  typeof value === "string" && (TEXT_LANGUAGES as readonly string[]).includes(value);

/** Each language as it names itself, as the app names it. */
export const LANGUAGE_NAMES: Readonly<Record<TextLanguage, string>> = {
  fr: "Français",
  en: "English",
  de: "Deutsch",
  "de-CH": "Deutsch (Schweiz)",
  it: "Italiano",
  es: "Español",
  pt: "Português",
  fi: "Suomi"
};

/** The language a tool names (« de » for « de-CH »: the locale tells the variant). */
export function baseOf(language: TextLanguage): Language {
  return language === "de-CH" ? "de" : language;
}

/**
 * The locale a PDF in `language` writes its numbers in, the AI app's being `appLocale` (the app's
 * documentLocale): the AI app's own when it is in that language, else the language in its region
 * (« en-CH »); German's variant decides its own: « de-CH », or « de-DE » in Switzerland and
 * Liechtenstein. Without a region, the language alone (the server then takes the merchant's).
 */
export function documentLocale(language: TextLanguage, appLocale: string | undefined): string {
  if (appLocale !== undefined && languageOf(appLocale, null) === language) return appLocale;
  if (language === "de-CH") return "de-CH";
  const region = regionOf(appLocale);
  if (language === "de" && swissRegion(region)) return "de-DE";
  return region === null ? language : `${language}-${region}`;
}

/** The AI app's locale if it is one, else the runtime's. */
export function localeOf(locale: string | undefined): string | undefined {
  if (locale === undefined) return undefined;
  try {
    return Intl.getCanonicalLocales(locale)[0];
  } catch {
    return undefined;
  }
}

/**
 * A decimal text (« 3904.10 ») with the locale's group and decimal signs, digit for digit: never
 * through a float.
 */
export function formatDecimal(
  value: string,
  locale: string | undefined,
  trimZeros = false
): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return value;
  let fraction = match[2] ?? "";
  if (trimZeros) fraction = fraction.replace(/0+$/, "");
  let group = ",";
  let point = ".";
  const format = new Intl.NumberFormat(locale);
  for (const part of format.formatToParts(1234567.5)) {
    if (part.type === "group") group = part.value;
    if (part.type === "decimal") point = part.value;
  }
  // Some locales (it-CH, es…) group thousands from five digits on only.
  const fromDigits = format.formatToParts(1000).some((part) => part.type === "group") ? 4 : 5;
  const digits = match[1] ?? "0";
  const whole =
    digits.length < fromDigits ? digits : digits.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return fraction === "" ? whole : `${whole}${point}${fraction}`;
}

/** An amount and its currency (« 3’904.10 CHF »), from the server's « 3904.10 CHF » or apart. */
export function formatMoney(value: string, currency: string, locale: string | undefined): string {
  return `${formatDecimal(value, locale)} ${currency}`;
}

/** « 3904.10 CHF » split. */
export function splitTotal(total: string): { amount: string; currency: string } {
  const [amount = total, currency = ""] = total.split(" ");
  return { amount, currency };
}

/** A calendar day (« 2026-12-03 ») in the locale's words, as a day: no time zone moves it. */
export function formatDay(day: string, locale: string | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(at);
}

/** What the model is told of the card's invoice (ui/update-model-context), in English. */
export function contextOfMade(made: Made): string {
  return made.alreadyMade
    ? `The invoice card shows invoice ${made.number} (${made.total}, due ${made.dueDate}), already made: never make it again.`
    : `The user made invoice ${made.number} (${made.total}, due ${made.dueDate}) with the invoice card's button: it is made, never make it again. Its payment link: ${made.paymentLink}`;
}

export function contextOfDraft(preview: Preview): string {
  const r = preview.draft.recipient;
  const address = [r.street, `${r.postalCode} ${r.city}`.trim(), r.country]
    .filter((part) => part.trim() !== "")
    .join(", ");
  return `In the invoice card, the user completed the invoice: ${r.name}, ${address}${r.reference === "" ? "" : `, reference ${r.reference}`}; total ${preview.total} ${preview.currency}, due ${preview.draft.dueDate}. It is not made yet: the user makes it with the card's button.`;
}
