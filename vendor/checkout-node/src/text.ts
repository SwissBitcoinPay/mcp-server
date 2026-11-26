/*
 * Text rules that every implementation applies alike (SPEC.md, "Text"): lengths in Unicode code
 * points, case folding and trimming of ASCII only, strict UTF-8. JavaScript's own `length`,
 * `trim()` and `toLowerCase()` follow other rules (UTF-16 units, Unicode spaces, the Kelvin sign
 * lowered to "k"), which other languages do not share.
 */

// `ignoreBOM`: a leading byte order mark is kept (U+FEFF), never dropped: UTF-8 is decoded strictly
// (SPEC.md §6). Only an HTTP body ignores one (SPEC.md §15, http.ts).
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/** Unicode code points of `text`. */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** Bytes of `text` in UTF-8. */
export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/**
 * The text of UTF-8 `bytes`; null when they are not valid UTF-8 (never repaired). A leading byte
 * order mark is kept, as any other character.
 */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

/** `text` with A–Z lowered to a–z, and nothing else changed. */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

/** `text` without leading and trailing ASCII whitespace (space, tab, line feed, carriage return). */
export function trimAscii(text: string): string {
  return text.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
}

/** Whether `text` holds a C0 control character (U+0000 to U+001F) or DEL (U+007F). */
export function hasControlCharacter(text: string): boolean {
  // eslint-disable-next-line no-control-regex -- the control characters are what is looked for.
  return /[\u0000-\u001f\u007f]/.test(text);
}

/** Whether `text` is well-formed Unicode (no lone surrogate): what UTF-8 can carry. */
export function isWellFormed(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

/** Lowercase hex of 32 bytes. */
export function isHex32(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Lowercase hex of 64 bytes. */
export function isHex64(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{128}$/.test(value);
}

/** A JSON object (not null, not an array). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
