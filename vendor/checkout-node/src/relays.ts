import { base64UrlToBytes } from "./encoding.js";
import { MAX_RELAYS, MAX_RELAY_URL_LENGTH } from "./protocol.js";
import { codePointLength, decodeUtf8, isWellFormed } from "./text.js";
import { isHost, isPort } from "./urls.js";

/*
 * Lists of Nostr relays, as the merchant's app writes them (SPEC.md, "Relay lists"):
 * every address a `wss://` URL in its one spelling, 1 to 10 of them, none twice. A list that is not
 * so is refused, never repaired.
 */

const PREFIX = "wss://";
/**
 * A lowercase host name, an optional port, an optional path without whitespace, query, fragment
 * nor comma: the merchant's app's rule, whose `\s` is ECMAScript's whitespace,
 * spelled out here for other languages (SPEC.md, "Relay lists").
 */
const ADDRESS =
  /^([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(:[0-9]{1,5})?(\/[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff?#,]*)?$/;

/**
 * Whether `url` is a relay address in its one spelling: `wss://`, a lowercase host name (not
 * `localhost` nor a name under it), an optional port (1 to 65535) and an optional path without a
 * trailing slash, 120 code points at most (the app counts UTF-16 units: never fewer, so whatever it
 * writes is read).
 */
export function isRelayUrl(url: string): boolean {
  if (!url.startsWith(PREFIX)) return false;
  const match = ADDRESS.exec(url.slice(PREFIX.length));
  if (!match) return false;
  const path = match[3] ?? "";
  return (
    isHost(match[1]!) &&
    isPort(match[2]?.slice(1)) &&
    !path.endsWith("/") &&
    // A lone surrogate (a JSON escape in a channel makes one) is no text (SPEC.md §6).
    isWellFormed(path) &&
    codePointLength(url) <= MAX_RELAY_URL_LENGTH
  );
}

/** A valid list (1 to MAX_RELAYS addresses in their one spelling, none twice), else null. */
export function parseRelayList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RELAYS) return null;
  const list: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isRelayUrl(item) || list.includes(item)) return null;
    list.push(item);
  }
  return list;
}

/** The list of a key's part: hosts without `wss://`, joined by commas, in base64url. */
export function decodeRelayList(text: string): string[] | null {
  const bytes = base64UrlToBytes(text);
  const decoded = bytes && bytes.length > 0 ? decodeUtf8(bytes) : null;
  if (decoded === null) return null;
  return parseRelayList(decoded.split(",").map((host) => `${PREFIX}${host}`));
}

export function sameRelayList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((relay, index) => relay === b[index]);
}
