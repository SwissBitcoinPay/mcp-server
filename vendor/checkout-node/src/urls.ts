import { MAX_HOST_LENGTH, MAX_HTTPS_URL_LENGTH } from "./protocol.js";

/*
 * Hosts and https URLs, in their one spelling (SPEC.md, "Relay lists", "HTTP"): what the package
 * asks over the network (relays, the Lightning address's pay URL, its callback and verify URLs) and
 * what a checkout link sends the customer to. Nothing is repaired: a URL that is not so is refused,
 * so that no request goes to an IP address, to the machine itself (`localhost` and the names under
 * it, RFC 6761) or to a host other than the one checked.
 */

/** A host: labels of `a–z 0–9 -` separated by `.`, the last of at least two letters `a–z`. */
const HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;
/** The characters of a redirect URL and of an https URL: RFC 3986's, and `%` with two hex digits. */
export const URL_CHARACTERS = /^(?:[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]|%[0-9A-Fa-f]{2})+$/;
/** `https://`, the authority (up to the first `/`, `?` or `#`), then anything. */
const HTTPS = /^https:\/\/([^/?#]*)(?:[/?#].*)?$/;
/** An authority: a host and an optional port of 1 to 5 digits. */
const AUTHORITY = /^([^:]*)(?::([0-9]{1,5}))?$/;

/**
 * Whether `host` is a host as in a relay address: lower case, at most 253 characters, so never an IP
 * address; its last label not `localhost`, which names the machine's own loopback (RFC 6761).
 */
export function isHost(host: string): boolean {
  return host.length <= MAX_HOST_LENGTH && HOST.test(host) && !/(?:^|\.)localhost$/.test(host);
}

/** Whether `port` (its digits, absent when the URL has none) is absent or 1 to 65535. */
export function isPort(port: string | undefined): boolean {
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65535);
}

/** An https URL's host and port: 443 when it names none. */
export type HttpsUrl = { host: string; port: number };

/**
 * `value` as an https URL (SPEC.md, "HTTP": rule 1 of a redirect URL): 1 to 2048 characters of a
 * redirect URL, `https://`, a host, an optional port, then nothing or `/`, `?` or `#` and anything.
 * So no upper case in the scheme or the host, no user name nor password, no IP address, no
 * whitespace, no `\`. Null when it is not one.
 */
export function parseHttpsUrl(value: unknown): HttpsUrl | null {
  if (
    typeof value !== "string" ||
    value.length > MAX_HTTPS_URL_LENGTH ||
    !URL_CHARACTERS.test(value)
  ) {
    return null;
  }
  const authority = AUTHORITY.exec(HTTPS.exec(value)?.[1] ?? "");
  if (!authority || !isHost(authority[1]!) || !isPort(authority[2])) return null;
  return { host: authority[1]!, port: authority[2] === undefined ? 443 : Number(authority[2]) };
}

/** Whether two https URLs are on the same host: their hosts and their ports are equal. */
export function sameHost(a: HttpsUrl, b: HttpsUrl): boolean {
  return a.host === b.host && a.port === b.port;
}
