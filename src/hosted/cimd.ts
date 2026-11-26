import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

import { redirectsAllowed } from "./redirects.js";

/*
 * OAuth Client ID Metadata Documents (CIMD; MCP authorization 2025-11-25, "Client ID Metadata
 * Documents"; draft-ietf-oauth-client-id-metadata-document-03): a client whose client_id is an
 * https URL publishes its metadata there, and the server reads it instead of a registration. Claude
 * and ChatGPT use it when the server says it supports it. What the merchant is shown is then the
 * host of that URL, which the client proves by serving the document (claude.ai, chatgpt.com), not a
 * name it declares.
 *
 * The server fetches a URL a stranger chooses: only https, only public addresses (never this
 * machine, its network, nor any special-use range: checked on every address the name resolves to,
 * the one connected to among them), no redirect followed, 5 kB and 5 seconds at most. A document
 * is kept as its Cache-Control says, between a minute and a day (an hour when it says nothing), and
 * a day at most when it cannot be read again for a while (a network failure, its server's error).
 */

/** What a client's document may weigh (the draft's recommended maximum). */
const MAX_BYTES = 5 * 1024;
const TIMEOUT_MS = 5000;
const MIN_FRESH_SECONDS = 60;
const MAX_FRESH_SECONDS = 86_400;
const DEFAULT_FRESH_SECONDS = 3600;
/** How long a document read is used when it cannot be read again for a transient reason. */
const STALE_SECONDS = 86_400;
/** Documents kept in memory at most (the oldest go first). */
const MAX_CACHED = 1000;
const MAX_URL_LENGTH = 2048;

/** Why a client's document cannot serve: `transient` when trying again later may work. */
export class ClientDocumentError extends Error {
  readonly transient: boolean;

  constructor(message: string, transient: boolean) {
    super(message);
    this.name = "ClientDocumentError";
    this.transient = transient;
  }
}

/** A document as its server answered it. */
export type FetchedDocument = { body: string; cacheControl: string | null };

/** Fetches a client's document; throws ClientDocumentError. Replaced in tests. */
export type DocumentFetcher = (url: URL) => Promise<FetchedDocument>;

/** Whether a client_id is a client's document's URL (the server's own client_ids never are). */
export function isDocumentClientId(clientId: string): boolean {
  return clientId.startsWith("https://");
}

/**
 * The URL of a client's document, when `clientId` is one a server may fetch (the draft's §3): https,
 * no user, a path other than "/", no "." nor ".." segment, no query, no fragment, written as a URL
 * parser writes it (compared as text). Null otherwise.
 */
export function documentUrl(clientId: string): URL | null {
  if (clientId.length > MAX_URL_LENGTH || /[\s\\]/.test(clientId)) return null;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (url.href !== clientId || url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return null;
  }
  if (url.pathname === "/" || clientId.includes("#") || clientId.includes("?")) return null;
  const segments = url.pathname.split("/").map((segment) => segment.toLowerCase());
  if (segments.some((s) => s === "." || s === ".." || s.includes("%2e"))) return null;
  return url;
}

/** Addresses no client's document is fetched from: this machine, private and special-use ranges. */
const SPECIAL = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const) {
  SPECIAL.addSubnet(address, prefix, "ipv4");
}
/** IPv6: global unicast only (2000::/3), less its special-use parts (NAT64 is outside it). */
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20]
] as const) {
  SPECIAL.addSubnet(address, prefix, "ipv6");
}

/** Whether `address` (an IP literal) is a public one a document may be fetched from. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !SPECIAL.check(address, "ipv4");
  if (family === 6) return GLOBAL_V6.check(address, "ipv6") && !SPECIAL.check(address, "ipv6");
  return false;
}

export type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void;

/**
 * The DNS lookup of the fetch: every address the name resolves to must be public, and the
 * connection is made to those only (a name that resolves elsewhere a second time changes nothing).
 * The hosted server's other requests use it too (egress.ts).
 */
export function publicLookup(
  hostname: string,
  options: { all?: boolean },
  callback: LookupCallback
) {
  dnsLookup(hostname, { all: true }, (error, addresses) => {
    if (error) {
      callback(error, []);
      return;
    }
    if (addresses.length === 0 || !addresses.every(({ address }) => isPublicAddress(address))) {
      const refused: NodeJS.ErrnoException = new Error("Not a public address");
      refused.code = "ENOTPUBLIC";
      callback(refused, []);
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}

/** Fetches a client's document from the Internet, as the module's comment says. */
export const fetchDocument: DocumentFetcher = (url) =>
  new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // A literal address is not looked up: checked here.
    if (isIP(host) !== 0 && !isPublicAddress(host)) {
      reject(new ClientDocumentError("not a public address", false));
      return;
    }
    const req = request(
      url,
      {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": "sattle.me-mcp" },
        lookup: publicLookup,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          res.resume();
          // Never followed: a redirect is an answer that is not the document.
          reject(new ClientDocumentError(`answered ${status}`, status >= 500 || status === 429));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy();
            reject(new ClientDocumentError("larger than 5 kB", false));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const cacheControl = res.headers["cache-control"];
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            cacheControl: typeof cacheControl === "string" ? cacheControl : null
          });
        });
        res.on("error", () => reject(new ClientDocumentError("cut off", true)));
      }
    );
    req.on("error", (error: NodeJS.ErrnoException) => {
      const refused = error.code === "ENOTPUBLIC";
      reject(new ClientDocumentError(refused ? "not a public address" : "unreachable", !refused));
    });
    req.end();
  });

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

/**
 * The client a document describes (the draft's §4 to §6), for `url`: its client_id that very URL,
 * its redirect URIs those the server's rules allow (redirects.ts), no shared secret, and a public
 * client (`none`) at the token endpoint, the only way the server authenticates such a client.
 */
export function clientOfDocument(
  url: URL,
  body: string,
  allowedRedirects: readonly string[] | null
): OAuthClientInformationFull {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new ClientDocumentError("not JSON", false);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ClientDocumentError("not a JSON object", false);
  }
  const doc = value as Record<string, unknown>;
  if (doc.client_id !== url.href) throw new ClientDocumentError("its client_id is another", false);
  const redirects = strings(doc.redirect_uris);
  if (!redirects || !redirectsAllowed(redirects, allowedRedirects)) {
    throw new ClientDocumentError("its redirect URIs are not allowed", false);
  }
  if ("client_secret" in doc || "client_secret_expires_at" in doc) {
    throw new ClientDocumentError("it holds a secret", false);
  }
  if ("jwks" in doc && "jwks_uri" in doc) {
    throw new ClientDocumentError("it has both jwks and jwks_uri", false);
  }
  // The methods it supports, else the one it names, else none (never RFC 7591's default).
  const methods = strings(doc.token_endpoint_auth_methods_supported);
  const method = doc.token_endpoint_auth_method;
  const publicClient = methods
    ? methods.includes("none")
    : method === undefined || method === "none";
  if (!publicClient) throw new ClientDocumentError("it is not a public client", false);
  const grants = doc.grant_types === undefined ? ["authorization_code"] : strings(doc.grant_types);
  const responses = doc.response_types === undefined ? ["code"] : strings(doc.response_types);
  if (!grants?.includes("authorization_code") || !responses?.includes("code")) {
    throw new ClientDocumentError("it does not use authorization codes", false);
  }
  const name = text(doc.client_name, 100);
  return {
    client_id: url.href,
    redirect_uris: redirects,
    token_endpoint_auth_method: "none",
    grant_types: grants.filter(
      (grant) => grant === "authorization_code" || grant === "refresh_token"
    ),
    response_types: ["code"],
    ...(name ? { client_name: name } : {})
  };
}

/** How long a document is fresh, by its Cache-Control (seconds). */
export function freshSeconds(cacheControl: string | null): number {
  if (!cacheControl) return DEFAULT_FRESH_SECONDS;
  const directives = cacheControl
    .toLowerCase()
    .split(",")
    .map((part) => part.trim());
  if (directives.includes("no-store") || directives.includes("no-cache")) return 0;
  const maxAge = directives.map((part) => /^max-age=(\d{1,10})$/.exec(part)).find(Boolean);
  if (!maxAge) return DEFAULT_FRESH_SECONDS;
  return Math.min(Math.max(Number(maxAge[1]), MIN_FRESH_SECONDS), MAX_FRESH_SECONDS);
}

type Cached = { client: OAuthClientInformationFull; freshUntil: number; staleUntil: number };

/** The clients of documents read, kept as the module's comment says. */
export class ClientDocuments {
  readonly #fetch: DocumentFetcher;
  readonly #now: () => number;
  readonly #allowedRedirects: readonly string[] | null;
  /** URLs a client_id may never be: the server's own (the draft's §10.1). */
  readonly #own: ReadonlySet<string>;
  readonly #cache = new Map<string, Cached>();
  readonly #reading = new Map<string, Promise<OAuthClientInformationFull>>();

  constructor(options: {
    fetch: DocumentFetcher;
    /** Unix seconds. */
    now: () => number;
    allowedRedirects: readonly string[] | null;
    own: readonly string[];
  }) {
    this.#fetch = options.fetch;
    this.#now = options.now;
    this.#allowedRedirects = options.allowedRedirects;
    this.#own = new Set(options.own);
  }

  /** The client whose client_id is `clientId`; throws ClientDocumentError. */
  async client(clientId: string): Promise<OAuthClientInformationFull> {
    const url = documentUrl(clientId);
    if (!url || this.#own.has(clientId)) {
      throw new ClientDocumentError("not a client ID metadata document's URL", false);
    }
    const cached = this.#cache.get(clientId);
    const now = this.#now();
    if (cached && cached.freshUntil > now) return cached.client;
    // One reading at a time for a URL: requests at once wait for the same answer.
    let reading = this.#reading.get(clientId);
    if (!reading) {
      reading = this.#read(url).finally(() => this.#reading.delete(clientId));
      this.#reading.set(clientId, reading);
    }
    try {
      return await reading;
    } catch (error) {
      // Its server unreachable for now: what was read stays usable for a day.
      if (error instanceof ClientDocumentError && error.transient && cached) {
        if (cached.staleUntil > now) return cached.client;
      }
      if (!(error instanceof ClientDocumentError) || !error.transient) {
        this.#cache.delete(clientId);
      }
      throw error;
    }
  }

  async #read(url: URL): Promise<OAuthClientInformationFull> {
    const fetched = await this.#fetch(url);
    const client = clientOfDocument(url, fetched.body, this.#allowedRedirects);
    const now = this.#now();
    this.#cache.delete(url.href);
    if (this.#cache.size >= MAX_CACHED) {
      this.#cache.delete(this.#cache.keys().next().value!);
    }
    this.#cache.set(url.href, {
      client,
      freshUntil: now + freshSeconds(fetched.cacheControl),
      staleUntil: now + STALE_SECONDS
    });
    return client;
  }
}
