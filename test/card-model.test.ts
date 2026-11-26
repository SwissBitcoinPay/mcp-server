import { describe, expect, it } from "vitest";

import {
  argumentsOf,
  baseOf,
  contextOfMade,
  documentLocale,
  draftOfArguments,
  dueRangeOf,
  formatDay,
  formatDecimal,
  hostOf,
  httpsUrl,
  isTextLanguage,
  LANGUAGE_NAMES,
  languageOf,
  LANGUAGES,
  localeOf,
  missingFields,
  readAnswer,
  readMade,
  readPreview,
  splitTotal,
  TEXT_LANGUAGES,
  variantOf
} from "../ui/model.js";
import { fill, TEXTS } from "../ui/texts.js";

/*
 * The invoice card's logic (ui/model.ts) and words (ui/texts.ts), without a page: what it reads of
 * the tools' answers, what it sends back, how it writes amounts and dates.
 */

const text = (value: unknown, isError?: boolean) => ({
  ...(isError === undefined ? {} : { isError }),
  content: [{ type: "text", text: JSON.stringify(value) }]
});

const preview = {
  canInvoice: true,
  issuer: "Marie Conseil",
  currency: "CHF",
  recipient: {
    name: "Dupont SA",
    street: "Gare 12",
    postalCode: "1003",
    city: "Lausanne",
    country: "CH",
    reference: ""
  },
  lines: [
    { description: "Conseil (jours)", quantity: "3.00", unitPrice: "1200.00", vatRate: "8.10" },
    { description: "Débours", quantity: "1.00", unitPrice: "12.50", vatRate: "0.00" }
  ],
  net: "3612.50",
  vat: [
    { rate: "8.10", base: "3600.00", vat: "291.60" },
    { rate: "0.00", base: "12.50", vat: "0.00" }
  ],
  total: "3904.10",
  dueDate: "2026-12-03",
  terms: "",
  legal: "",
  redirectUrl: null,
  language: "fr",
  timeZone: "Europe/Zurich",
  dueDates: { first: "2026-11-04", last: "2027-08-03" },
  previewedAt: "2026-11-03T10:20:00.000Z"
};

const made = {
  id: "0123456789abcdef0123456789abcdef",
  number: "2026-0001",
  recipient: "Dupont SA",
  total: "3904.10 CHF",
  issued: "2026-11-03T10:20:30.000Z",
  dueDate: "2026-12-03",
  paymentLink: "https://pay.example/pay#abc",
  alreadyMade: false
};

describe("the card's reading of an answer", () => {
  it("reads a tool's text as JSON, and its error with the preview's second", () => {
    expect(readAnswer(text({ a: 1 }))).toEqual({ ok: true, value: { a: 1 } });
    expect(
      readAnswer(
        text(
          {
            error: "invalid_invoice",
            message: "The invoice is not valid",
            details: ["recipient", 7],
            previewedAt: "2026-11-03T10:20:00.000Z"
          },
          true
        )
      )
    ).toEqual({
      ok: false,
      failure: {
        error: "invalid_invoice",
        message: "The invoice is not valid",
        details: ["recipient"],
        previewedAt: "2026-11-03T10:20:00.000Z"
      }
    });
  });

  it("says unreadable what is not a tool's JSON text, never something else", () => {
    for (const result of [
      null,
      "text",
      { content: [] },
      { content: [{ type: "image", data: "" }] },
      { content: [{ type: "text", text: "not json" }] },
      text("an error that is not an object", true)
    ]) {
      const answer = readAnswer(result);
      expect(answer.ok).toBe(false);
      if (!answer.ok) expect(answer.failure.error).toBe("unreadable");
    }
    const odd = readAnswer(text({ error: "network", previewedAt: "yesterday" }, true));
    expect(odd).toMatchObject({ ok: false, failure: { error: "network", previewedAt: null } });
  });

  it("reads a preview, with all create_invoice takes, and refuses one that is off", () => {
    const read = readPreview(preview)!;
    expect(read).toMatchObject({ currency: "CHF", total: "3904.10", alreadyMade: undefined });
    expect(argumentsOf(read.draft)).toEqual({
      recipient: preview.recipient,
      lines: preview.lines,
      dueDate: "2026-12-03",
      terms: "",
      legal: "",
      language: "fr",
      timeZone: "Europe/Zurich",
      previewedAt: "2026-11-03T10:20:00.000Z"
    });
    expect(readPreview({ ...preview, alreadyMade: null })!.alreadyMade).toBeNull();
    // Told made but not readable: the preview is not read, never taken as « not made ».
    expect(readPreview({ ...preview, alreadyMade: { number: "2026-0001" } })).toBeNull();
    expect(readPreview({ ...preview, alreadyMade: made })!.alreadyMade).toMatchObject({
      number: "2026-0001",
      alreadyMade: true
    });
    for (const off of [
      { total: 3904.1 },
      { total: "3904.10 CHF" },
      { net: "-1" },
      { currency: "chf" },
      { previewedAt: "2026-11-03" },
      { dueDate: "03.12.2026" },
      { lines: [] },
      { lines: [{ description: "x", quantity: "1", unitPrice: "1e3", vatRate: "0" }] },
      { recipient: { ...preview.recipient, city: 3 } },
      { vat: [{ rate: "8.1", base: "1", vat: null }] }
    ]) {
      expect(readPreview({ ...preview, ...off }), JSON.stringify(off)).toBeNull();
    }
  });

  it("reads an invoice made only with an https payment link and its number", () => {
    // What the card shows of it (not when it was issued).
    expect(readMade(made)).toEqual({ ...made, issued: undefined });
    expect(readMade({ ...made, alreadyMade: true })!.alreadyMade).toBe(true);
    for (const off of [
      { paymentLink: "http://pay.example/pay" },
      { paymentLink: "javascript:alert(1)" },
      { number: "42" },
      { id: "x" },
      { total: "3904.10" }
    ]) {
      expect(readMade({ ...made, ...off }), JSON.stringify(off)).toBeNull();
    }
  });
});

describe("the card's links", () => {
  it("keeps a redirect URL as written: the server compares the texts", () => {
    const read = readPreview({ ...preview, redirectUrl: "https://Shop.example.com" })!;
    expect(read.draft.redirectUrl).toBe("https://Shop.example.com");
    expect(argumentsOf(read.draft).redirectUrl).toBe("https://Shop.example.com");
    expect(httpsUrl(" https://shop.example.com:443/a b ")).toBe("https://shop.example.com:443/a b");
    for (const off of ["http://shop.example.com", "javascript:alert(1)", "https://", "", 7]) {
      expect(httpsUrl(off), String(off)).toBeNull();
    }
    expect(hostOf("https://shop.example.com/merci?x=1")).toBe("shop.example.com");
    expect(hostOf("not a link")).toBe("not a link");
  });
});

describe("the card's draft", () => {
  it("is completed from a call's arguments: what they leave out is empty", () => {
    const draft = draftOfArguments(
      {
        recipient: { name: "Dupont SA", country: "CH" },
        lines: [{ description: "Conseil", unitPrice: "1200" }],
        dueDate: "2026-12-03"
      },
      "2026-11-03T10:20:00.000Z"
    )!;
    expect(missingFields(draft.recipient)).toEqual(["street", "postalCode", "city"]);
    expect(argumentsOf(draft)).toEqual({
      recipient: {
        name: "Dupont SA",
        street: "",
        postalCode: "",
        city: "",
        country: "CH",
        reference: ""
      },
      // The default VAT rate stays the merchant's: none is sent.
      lines: [{ description: "Conseil", quantity: "1", unitPrice: "1200" }],
      dueDate: "2026-12-03",
      terms: "",
      legal: "",
      previewedAt: "2026-11-03T10:20:00.000Z"
    });
    expect(draftOfArguments({ recipient: {}, lines: [] }, null)).toBeNull();
    // What the server would refuse is kept, for it to refuse: never dropped by the card.
    const lines = [{ description: "Conseil", unitPrice: "1200" }];
    expect(
      draftOfArguments({ recipient: {}, lines, redirectUrl: "http://shop.example.com" }, null)!
        .redirectUrl
    ).toBe("http://shop.example.com");
    expect(draftOfArguments({ recipient: {}, lines, terms: "x".repeat(4001) }, null)).toBeNull();
    expect(draftOfArguments({ recipient: {}, lines, legal: 3 }, null)).toBeNull();
    expect(draftOfArguments(null, null)).toBeNull();
  });

  it("misses a country that is not two letters, and blank fields", () => {
    const recipient = {
      name: " ",
      street: "Gare 12",
      postalCode: "1003",
      city: "Lausanne",
      country: "Suisse",
      reference: ""
    };
    expect(missingFields(recipient)).toEqual(["name", "country"]);
    expect(missingFields({ ...recipient, name: "Dupont", country: "ch" })).toEqual([]);
  });
});

describe("the card's amounts and dates", () => {
  it("writes a decimal text with the locale's signs, digit for digit", () => {
    // Above what a float holds exactly: never through a number.
    expect(formatDecimal("9007199254740993.25", "en-US")).toBe("9,007,199,254,740,993.25");
    // As Intl writes an amount a float holds exactly (its signs vary with the ICU data).
    for (const locale of [
      "de-CH",
      "de-DE",
      "fr-CH",
      "fr-FR",
      "it-CH",
      "es-ES",
      "en-US",
      "fi-FI",
      "pt-PT"
    ]) {
      const intl = new Intl.NumberFormat(locale, { minimumFractionDigits: 2 });
      expect(formatDecimal("3904.10", locale), locale).toBe(intl.format(3904.1));
      expect(formatDecimal("1234567.50", locale), locale).toBe(intl.format(1234567.5));
      expect(formatDecimal("12.50", locale), locale).toBe(intl.format(12.5));
    }
    expect(formatDecimal("3.00", "fr-CH", true)).toBe("3");
    expect(formatDecimal("1.50", "fr-CH", true)).toBe("1,5");
    expect(formatDecimal("not a number", "fr-CH")).toBe("not a number");
    expect(splitTotal("3904.10 CHF")).toEqual({ amount: "3904.10", currency: "CHF" });
  });

  it("writes a due date as that day, whatever the time zone", () => {
    expect(formatDay("2026-12-03", "fr-CH")).toBe("3 décembre 2026");
    expect(formatDay("2026-12-03", "en-US")).toBe("December 3, 2026");
    expect(formatDay("2027-01-01", "de-CH")).toBe("1. Januar 2027");
  });

  it("reads the due dates allowed from the server's problem", () => {
    expect(dueRangeOf(["recipient", "dueDate: from 2026-11-04 to 2027-08-03"])).toEqual({
      first: "2026-11-04",
      last: "2027-08-03"
    });
    expect(dueRangeOf(["dueDate"])).toBeNull();
  });

  it("speaks the AI app's language, else the invoice's, else English", () => {
    // German as the AI app's region writes it: Swiss German in Switzerland.
    expect(languageOf("de-CH", "fr")).toBe("de-CH");
    expect(languageOf("de-DE", "fr")).toBe("de");
    expect(languageOf("ja-JP", "it")).toBe("it");
    expect(languageOf(undefined, null)).toBe("en");
    expect(localeOf("fr-ch")).toBe("fr-CH");
    expect(localeOf("not a locale!")).toBeUndefined();
  });

  it("tells the model an invoice made by the card, never to make it again", () => {
    expect(contextOfMade(readMade(made)!)).toMatch(/2026-0001 .*never make it again/);
    expect(contextOfMade({ ...readMade(made)!, alreadyMade: true })).toMatch(/already made/);
  });
});

describe("the card's words", () => {
  it("are all there in every language of the app, with French's placeholders", () => {
    const placeholders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort().join();
    const flat = (texts: object, prefix = ""): [string, string][] =>
      Object.entries(texts).flatMap(([key, value]: [string, unknown]) =>
        typeof value === "string"
          ? [[`${prefix}${key}`, value] as [string, string]]
          : flat(value as object, `${prefix}${key}.`)
      );
    const source = new Map(flat(TEXTS.fr));
    // German in its two variants too (« de-CH »).
    expect(Object.keys(TEXTS)).toEqual([...LANGUAGES.slice(0, 3), "de-CH", ...LANGUAGES.slice(3)]);
    for (const language of Object.keys(TEXTS) as (keyof typeof TEXTS)[]) {
      const words = new Map(flat(TEXTS[language]));
      expect([...words.keys()], language).toEqual([...source.keys()]);
      for (const [key, value] of words) {
        expect(value.trim(), `${language} ${key}`).not.toBe("");
        expect(placeholders(value), `${language} ${key}`).toBe(placeholders(source.get(key)!));
        // No final period on a message, as in the app.
        expect(value.endsWith("."), `${language} ${key}`).toBe(false);
      }
    }
    expect(fill(TEXTS.fr.madeTitle, { number: "2026-0001" })).toBe("Facture 2026-0001 créée");
  });
});

describe("the PDF's language beside its button", () => {
  it("offers the app's languages, each by its own name, the card's words in each", () => {
    expect(TEXT_LANGUAGES).toEqual(["fr", "en", "de", "de-CH", "it", "es", "pt", "fi"]);
    expect(Object.keys(LANGUAGE_NAMES)).toEqual([...TEXT_LANGUAGES]);
    expect(Object.keys(TEXTS).sort()).toEqual([...TEXT_LANGUAGES].sort());
    expect(LANGUAGE_NAMES["de-CH"]).toBe("Deutsch (Schweiz)");
    expect(isTextLanguage("de-CH")).toBe(true);
    expect(isTextLanguage("de-AT")).toBe(false);
    expect(isTextLanguage("<script>")).toBe(false);
  });

  it("is first the invoice's, in German's variant of the AI app's region", () => {
    expect(variantOf("de", "de-CH")).toBe("de-CH");
    expect(variantOf("de", "fr-LI")).toBe("de-CH");
    expect(variantOf("de", "de-DE")).toBe("de");
    expect(variantOf("de", undefined)).toBe("de");
    expect(variantOf("fr", "fr-CH")).toBe("fr");
  });

  it("is asked of the server as a language and the locale of its numbers", () => {
    expect(baseOf("de-CH")).toBe("de");
    expect(baseOf("en")).toBe("en");
    // The AI app's own locale when it is in that language.
    expect(documentLocale("fr", "fr-CH")).toBe("fr-CH");
    expect(documentLocale("de-CH", "de-CH")).toBe("de-CH");
    // Another language in the AI app's region; German's variant its own.
    expect(documentLocale("en", "fr-CH")).toBe("en-CH");
    expect(documentLocale("de", "fr-CH")).toBe("de-DE");
    expect(documentLocale("de-CH", "en-US")).toBe("de-CH");
    expect(documentLocale("it", undefined)).toBe("it");
  });
});
