import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseAppleLanguages, pickLanguage } from "../src/locale.js";

/*
 * The local server's default language is the computer's (src/locale.ts): the bundle asks for no
 * language nor time zone. Here: the language picked from the computer's, and the bundle's settings.
 */
describe("the computer's language", () => {
  it("is the first the computer names that invoices exist in", () => {
    expect(pickLanguage(["fr-CH"])).toBe("fr");
    expect(pickLanguage(["de_DE.UTF-8"])).toBe("de");
    expect(pickLanguage(["it-IT", "fr"])).toBe("it");
    expect(pickLanguage(["ja-JP", "pt-BR", "en-US"])).toBe("pt");
    expect(pickLanguage(["FI"])).toBe("fi");
    expect(pickLanguage(["es_ES@euro"])).toBe("es");
  });

  it("is English when the computer names none of them", () => {
    expect(pickLanguage(["ja-JP", "zh-Hans"])).toBe("en");
    expect(pickLanguage([undefined, null, "", "C", "POSIX", "und"])).toBe("en");
    expect(pickLanguage([])).toBe("en");
  });

  it("reads macOS's preferred languages as `defaults read -g AppleLanguages` prints them", () => {
    expect(parseAppleLanguages('(\n    "fr-CH",\n    "en-CH"\n)\n')).toEqual(["fr-CH", "en-CH"]);
    expect(parseAppleLanguages("(\n    en,\n    de\n)\n")).toEqual(["en", "de"]);
    expect(parseAppleLanguages("(\n)\n")).toEqual([]);
    expect(parseAppleLanguages("The domain/default pair does not exist")).toEqual([]);
  });
});

describe("the Claude Desktop bundle's settings (manifest.json)", () => {
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8")) as {
    server: { mcp_config: { env: Record<string, string> } };
    user_config: Record<string, { title: string; description: string }>;
  };

  it("ask for the key and a folder only: the language and the time zone are the computer's", () => {
    expect(Object.keys(manifest.user_config)).toEqual(["assistant_key", "pdf_directory"]);
    expect(Object.keys(manifest.server.mcp_config.env)).toEqual([
      "SATTLEME_ASSISTANT_KEY",
      "SATTLEME_PDF_DIRECTORY"
    ]);
  });

  it("name the folder for exports and invoices, what an empty one means on its own line", () => {
    expect(manifest.user_config.pdf_directory).toMatchObject({
      title: "Folder for exports and invoices",
      description:
        "Where the invoices' PDFs and the exports are saved.\nEmpty: they are only shown in the conversation."
    });
  });
});
