import { describe, expect, it } from "vitest";

import { bcp47 } from "../src/locale.js";
import {
  acceptedLanguages,
  MAX_PREFERENCES,
  merchantRegion,
  preferredLocales
} from "../src/pdf/region.js";

/*
 * The merchant's region on an invoice's PDF (src/pdf/region.ts):
 * the one who makes the invoice, never its recipient, from what its own software tells.
 */

const swiss = { detectedCountry: "CH", businessAddress: null };
const unknown = { detectedCountry: null, businessAddress: null };
const address = (country: string) => ({
  detectedCountry: null,
  businessAddress: { street: "Rue 1", postalCode: "1003", city: "Ville", country }
});

describe("the merchant's region", () => {
  it("is first its preferred language's in the invoice's language", () => {
    expect(merchantRegion("de", ["fr-CH", "de-DE"], swiss)).toBe("DE");
    expect(merchantRegion("de", ["de_CH.UTF-8"], unknown)).toBe("CH");
    expect(merchantRegion("de", ["de-Latn-LI"], address("DE"))).toBe("LI");
  });

  it("is then the country its app detected, then its other languages' region", () => {
    // « en-US » is often only a browser's default: the app's detection comes first.
    expect(merchantRegion("de", ["en-US", "de"], swiss)).toBe("CH");
    expect(merchantRegion("de", ["en-US", "fr-CH"], unknown)).toBe("US");
    expect(merchantRegion("de", ["de", "fr-CH"], unknown)).toBe("CH");
  });

  it("is last its business's country, else none", () => {
    expect(merchantRegion("de", ["de"], address("CH"))).toBe("CH");
    expect(merchantRegion("fr", [], unknown)).toBeNull();
    // A UN M.49 area is no region of a country.
    expect(merchantRegion("es", ["es-419"], unknown)).toBeNull();
  });
});

describe("the merchant's preferred languages", () => {
  it("are read from a browser's Accept-Language, by weight, what is no language left out", () => {
    expect(acceptedLanguages("de-CH,de;q=0.9,en;q=0.8")).toEqual(["de-CH", "de", "en"]);
    expect(acceptedLanguages("en;q=0.5, fr-ch , *;q=0.9, de;q=0, it;q=0.5")).toEqual([
      "fr-CH",
      "en",
      "it"
    ]);
    expect(acceptedLanguages("<script>, de-CH;q=abc, -")).toEqual(["de-CH"]);
    expect(acceptedLanguages(undefined)).toEqual([]);
    expect(acceptedLanguages("de,".repeat(600))).toEqual([]);
  });

  it("are tags Intl knows, each once, of a bounded number", () => {
    expect(preferredLocales(["de-ch", "DE-CH", 42, null, "x".repeat(36), "de-CH-1996"])).toEqual([
      "de-CH",
      "de-CH-1996"
    ]);
    const many = ["fr", "en", "de", "it", "es", "pt", "fi", "nl", "sv", "da"];
    expect(preferredLocales(many)).toHaveLength(MAX_PREFERENCES);
  });

  it("are the computer's POSIX locales as BCP 47 tags", () => {
    expect(bcp47("de_CH.UTF-8")).toBe("de-CH");
    expect(bcp47("sr_RS@latin")).toBe("sr-RS");
    expect(preferredLocales([bcp47("C"), bcp47("POSIX"), bcp47("fr_CH")])).toEqual(["fr-CH"]);
  });
});
