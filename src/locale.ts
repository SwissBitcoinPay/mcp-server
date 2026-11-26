import { execFileSync } from "node:child_process";

import { preferredLocales } from "./pdf/region.js";
import { isLanguage, type Language } from "./protocol/constants.js";

/*
 * The computer's language, the local server's default for invoices (src/stdio.ts): the bundle asks
 * for none, the merchant's system says it.
 *
 * Node knows a language from the environment only (LC_ALL, LC_MESSAGES, LANG; tested: without them,
 * its locale is "und"). An app started from macOS's Finder or Dock, as Claude Desktop is, usually has
 * none: on macOS, the user's preferred languages (System Settings › General › Language & Region)
 * come first, read with `defaults`. On Windows, Node's own locale is the system's.
 */

/** The first of `candidates` (locale names, such as "fr-CH" or "de_DE.UTF-8") invoices exist in. */
export function pickLanguage(candidates: readonly (string | null | undefined)[]): Language {
  for (const candidate of candidates) {
    const language =
      (candidate ?? "")
        .trim()
        .toLowerCase()
        .split(/[-_.@]/)[0] ?? "";
    if (isLanguage(language)) return language;
  }
  return "en";
}

/** The languages of `defaults read -g AppleLanguages`: a list such as ( "fr-CH", en ). */
export function parseAppleLanguages(output: string): string[] {
  const list = /\(([\s\S]*)\)/.exec(output)?.[1] ?? "";
  return list
    .split(",")
    .map((item) => item.trim().replace(/^"(.*)"$/, "$1"))
    .filter((item) => item !== "");
}

/** The user's preferred languages on macOS, in order; none elsewhere or when they cannot be read. */
function appleLanguages(): string[] {
  if (process.platform !== "darwin") return [];
  try {
    const output = execFileSync("defaults", ["read", "-g", "AppleLanguages"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"]
    });
    return parseAppleLanguages(output);
  } catch {
    return [];
  }
}

/** The computer's locales, most preferred first, as it names them (« fr-CH », « de_CH.UTF-8 »). */
function computerCandidates(): (string | undefined)[] {
  return [
    ...appleLanguages(),
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
    Intl.DateTimeFormat().resolvedOptions().locale
  ];
}

/** The computer's language for invoices: the first it prefers that invoices exist in, else English. */
export function computerLanguage(): Language {
  return pickLanguage(computerCandidates());
}

/** A POSIX locale as a BCP 47 tag: « de_CH.UTF-8 » → « de-CH »; « C » and « POSIX », none (""). */
export function bcp47(locale: string): string {
  const name = locale.trim().split(/[.@]/)[0]!;
  return /^(?:C|POSIX)$/i.test(name) ? "" : name.replace(/_/g, "-");
}

/**
 * The computer's preferred languages, most preferred first, as BCP 47 tags: their regions are the
 * merchant's, which an invoice's PDF writes its numbers and words as (pdf/region.ts).
 */
export function computerPreferences(): string[] {
  return preferredLocales(
    computerCandidates().flatMap((candidate) => (candidate ? [bcp47(candidate)] : []))
  );
}
