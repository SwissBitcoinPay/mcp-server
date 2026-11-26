/*
 * Texts as the merchant's app counts them (SPEC.md §2): lengths in UTF-16 code units, blanks and
 * trims with ECMAScript's whitespace and line terminators. JavaScript's own `length` and `trim()`
 * are exactly those.
 */

/** Whether `value` is a text of at most `max` UTF-16 code units. */
export function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

/** Whether `value` is a text of at most `max` code units that is not blank. */
export function isFilledText(value: unknown, max: number): value is string {
  return isText(value, max) && value.trim() !== "";
}

/** Whether `value` is a text of at most `max` code units with no whitespace at either end. */
export function isTrimmedText(value: unknown, max: number): value is string {
  return isText(value, max) && value === value.trim();
}

/** Whether `value` is a lowercase hex string of 32 bytes. */
export function isHex32(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Whether `value` is a safe integer of 0 or more: a Unix time in seconds. */
export function isUnixSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
