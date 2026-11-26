import countries from "i18n-iso-countries";
import { describe, expect, it } from "vitest";

import { EXPORT_NOTES } from "../src/export/notes.js";
import { EXPORT_TEXTS } from "../src/export/texts.js";
import { invoiceWords } from "../src/pdf/invoice-pdf.js";
import { PDF_LABELS } from "../src/pdf/labels.js";
import { textLanguage } from "../src/protocol/constants.js";
import { languageOf } from "../ui/model.js";
import { TEXTS } from "../ui/texts.js";

/*
 * German in its two variants, as the merchant's app writes them (its src/i18n/locales/de.ts and
 * de-CH.ts): « de » as Germany and Austria write it, « de-CH » as Switzerland and Liechtenstein do,
 * picked by the locale's region.
 */

/** Every text of a tree of texts. */
function texts(tree: unknown): string[] {
  if (typeof tree === "string") return [tree];
  return Object.values(tree as Record<string, unknown>).flatMap(texts);
}

/** Each set of German words of the server, by variant. */
const WORDS = {
  pdf: PDF_LABELS,
  export: EXPORT_TEXTS,
  notes: EXPORT_NOTES,
  card: TEXTS
};

/** What only Germany writes: ß, „ “ and ‚ ‘. */
const GERMANY_ONLY = /[ßẞ„“‚‘]/;

/** What only Switzerland writes: ss where Germany writes ß, guillemets, Swiss words. */
const SWITZERLAND_ONLY = [
  /schliess|gröss|\bgross|strasse|dreissig|ausser|äusser|heiss|gemäss|mässig|grüss/i,
  /[«»‹›]/,
  /\binnert\b/i,
  /\bLimite/,
  /\bMWST\b(?!-Nummer)/,
  /\bNormalsatz\b/,
  /\bTotal\b/
];

describe("German's two variants", () => {
  it("follow the locale's region: Switzerland and Liechtenstein write Swiss German", () => {
    expect(textLanguage("de", "de-CH")).toBe("de-CH");
    expect(textLanguage("de", "de_LI")).toBe("de-CH");
    expect(textLanguage("de", "de-Latn-CH")).toBe("de-CH");
    // A Swiss phone in French, an export asked in German: Swiss German.
    expect(textLanguage("de", "fr-CH")).toBe("de-CH");
    expect(textLanguage("de", "de-DE")).toBe("de");
    expect(textLanguage("de", "de-AT")).toBe("de");
    expect(textLanguage("de", "de")).toBe("de");
    expect(textLanguage("de", null)).toBe("de");
    expect(textLanguage("fr", "fr-CH")).toBe("fr");
    expect(textLanguage("it", "it-CH")).toBe("it");
  });

  it("are the invoice's as the merchant's region writes German", () => {
    const at = (detectedCountry: string | null) => ({ detectedCountry, businessAddress: null });
    expect(invoiceWords("de", [], at("CH"))).toMatchObject({
      tag: "de-CH",
      labels: { vat: "MWST" }
    });
    expect(invoiceWords("de", ["de-LI"], at("DE")).labels.total).toBe("Total");
    expect(invoiceWords("de", ["de-DE"], at("CH"))).toMatchObject({
      tag: "de-DE",
      labels: { vat: "MwSt." }
    });
    expect(invoiceWords("de", [], at(null))).toMatchObject({
      tag: "de",
      labels: { total: "Gesamtbetrag" }
    });
    expect(invoiceWords("fr", ["fr-CH"], at(null))).toMatchObject({
      tag: "fr-CH",
      labels: { vat: "TVA" }
    });
  });

  it("are the card's as the AI app's region writes German, else the invoice's language", () => {
    expect(languageOf("de-CH", null)).toBe("de-CH");
    expect(languageOf("de-LI", "fr")).toBe("de-CH");
    expect(languageOf("de-DE", null)).toBe("de");
    expect(languageOf("de", "fr")).toBe("de");
    expect(languageOf("fr-CH", "de")).toBe("fr");
    expect(languageOf(undefined, "de")).toBe("de");
    expect(languageOf(undefined, null)).toBe("en");
  });

  it("write no ß nor German quotation marks in Swiss German", () => {
    for (const [name, words] of Object.entries(WORDS)) {
      for (const text of texts(words["de-CH"])) {
        expect([name, text, GERMANY_ONLY.test(text)]).toEqual([name, text, false]);
      }
    }
  });

  it("write German as Germany does: no Swiss spelling, guillemets nor Swiss words", () => {
    for (const [name, words] of Object.entries(WORDS)) {
      for (const text of texts(words.de)) {
        for (const swiss of SWITZERLAND_ONLY) {
          expect([name, text, swiss.test(text)]).toEqual([name, text, false]);
        }
      }
    }
  });

  it("say the same in both variants but for Swiss spelling and Switzerland's own words", () => {
    for (const words of Object.values(WORDS)) {
      const german = texts(words.de);
      const swiss = texts(words["de-CH"]);
      expect(swiss.length).toBe(german.length);
      for (const [index, text] of german.entries()) {
        // Every placeholder of a text is in its Swiss variant.
        const placeholders = (value: string) => value.match(/\{\{?\w+\}\}?/g) ?? [];
        expect(placeholders(swiss[index]!)).toEqual(placeholders(text));
      }
    }
  });

  it("name countries with no ß in German: Swiss German needs no other names", () => {
    const names = Object.values(countries.getNames("de", { select: "official" }));
    expect(names.length).toBeGreaterThan(200);
    for (const name of names) expect(name).not.toMatch(/ß/);
  });
});
