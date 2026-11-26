/*
 * JSON as every implementation reads it (SPEC.md §2): as JavaScript's JSON.parse reads it, but for
 * one bound that every platform's parser can keep without exhausting its stack: a text in which more
 * than MAX_JSON_DEPTH arrays and objects nest is not JSON.
 */

/** The most arrays and objects that nest one in another in a JSON text (SPEC.md §2). */
export const MAX_JSON_DEPTH = 64;

/**
 * The value of the JSON `text` (SPEC.md §2): JSON.parse's, once a scan found no more than
 * MAX_JSON_DEPTH arrays and objects nested in it (outside its strings). Throws a SyntaxError when it
 * is not JSON.
 */
export function readJson(text: string): unknown {
  if (fewOpenings(text)) return JSON.parse(text) as unknown;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (inString) {
      // A backslash escapes the next character (`\"` included): skipped.
      if (c === 0x5c) i += 1;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x5b || c === 0x7b) {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) {
        throw new SyntaxError(`More than ${MAX_JSON_DEPTH} arrays and objects nest in the JSON`);
      }
    } else if (c === 0x5d || c === 0x7d) {
      depth -= 1;
    }
  }
  return JSON.parse(text) as unknown;
}

/**
 * Whether `text` holds no more than MAX_JSON_DEPTH `[` and `{` in all, strings included: then
 * nothing in it nests deeper, and the scan of readJson is spared (a relay's event holds a few).
 */
function fewOpenings(text: string): boolean {
  let count = 0;
  for (const opening of ["[", "{"]) {
    for (let at = text.indexOf(opening); at !== -1; at = text.indexOf(opening, at + 1)) {
      count += 1;
      if (count > MAX_JSON_DEPTH) return false;
    }
  }
  return true;
}
