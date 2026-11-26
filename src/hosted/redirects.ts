import { REFUSED_REDIRECT_SCHEMES } from "../../vendor/checkout-node/src/protocol.js";

/*
 * Where an OAuth client of the hosted server may send the merchant back with its code (SPEC.md
 * §16): any MCP client (Claude, ChatGPT, an IDE…) registers its own redirect URIs (RFC 7591), as
 * OAuth for native apps allows them (RFC 8252): an https URL of a web client, a loopback URL of a
 * desktop client (http on localhost, 127.0.0.1 or [::1], any port), or a private-use scheme of an
 * app. Never a scheme that a browser runs or that opens something else (javascript:, data:, file:,
 * another browser, a payment), the list the payer's page refuses for a redirect (spec/SPEC.md §30).
 *
 * Which client it is cannot be proven: its name is what it says. The consent page shows where the
 * code goes, which the merchant checks; the server may also be limited to listed URIs
 * (MCP_ALLOWED_REDIRECTS).
 */

/** Redirect URIs a client may register at most. */
export const MAX_REDIRECTS = 10;
const MAX_LENGTH = 2048;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SCHEME = /^[a-z][a-z0-9+.-]{0,63}$/;

/** What the merchant is shown of a redirect URI: its host, or its scheme for an app. */
export type RedirectTarget = {
  kind: "web" | "loopback" | "app";
  shown: string;
  formAction: string;
};

/** Where `uri` sends the merchant back, when it may be registered; null when it may not. */
export function redirectTarget(uri: unknown): RedirectTarget | null {
  if (typeof uri !== "string" || uri.length > MAX_LENGTH || /[\s\\]/.test(uri)) return null;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  // A fragment never carries a code (RFC 6749 §3.1.2), a user name is a phishing aid.
  if (url.hash !== "" || uri.includes("#") || url.username !== "" || url.password !== "") {
    return null;
  }
  const scheme = url.protocol.slice(0, -1);
  if (scheme === "https") {
    if (url.hostname === "") return null;
    return { kind: "web", shown: url.host, formAction: url.origin };
  }
  if (scheme === "http") {
    if (!LOOPBACK.has(url.hostname)) return null;
    return { kind: "loopback", shown: url.host, formAction: url.origin };
  }
  if (!SCHEME.test(scheme) || REFUSED_REDIRECT_SCHEMES.has(scheme) || scheme === "https") {
    return null;
  }
  return { kind: "app", shown: `${scheme}:`, formAction: `${scheme}:` };
}

/**
 * Whether a client may register `uris`: 1 to MAX_REDIRECTS, each one a redirect URI the rules
 * allow, and, when the server lists them (`allowed`), each one listed.
 */
export function redirectsAllowed(
  uris: readonly string[],
  allowed: readonly string[] | null
): boolean {
  if (uris.length === 0 || uris.length > MAX_REDIRECTS) return false;
  if (!uris.every((uri) => redirectTarget(uri) !== null)) return false;
  return allowed === null || uris.every((uri) => allowed.includes(uri));
}
