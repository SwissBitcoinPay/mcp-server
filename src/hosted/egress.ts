import { isIP } from "node:net";

import { Agent, fetch as undiciFetch } from "undici";
import WsWebSocket from "ws";

import type { WebSocketLike } from "../../vendor/checkout-node/src/nostr/relay.js";
import { MAX_RELAY_MESSAGE_BYTES, USER_AGENT } from "../../vendor/checkout-node/src/protocol.js";
import { realServices } from "../assistant.js";
import type { Services } from "../protocol/context.js";
import { isPublicAddress, publicLookup } from "./cimd.js";

/*
 * What the hosted server reaches on a merchant's behalf: hosts that a key or a channel names (its
 * relays, its Lightning address and the URLs it answers, its Bitcoin node), so that anyone with a
 * key of their own makes the server connect where they choose, from `POST /consent` on. Hence, as
 * for a client's document (cimd.ts): only public addresses, checked on every address a name
 * resolves to (the one connected to among them) and on a literal address; only https and wss; a
 * relay on port 443 only. A Bitcoin node that is not of the Internet is not read (channel.ts).
 * Claude Desktop's server (stdio) runs on the merchant's own machine: it reaches its network as
 * the merchant does.
 */

/** Why the hosted server does not connect: the address or the port is not one it reaches. */
export class EgressRefused extends Error {
  constructor(url: string, why: string) {
    super(`${url}: ${why}`);
    this.name = "EgressRefused";
  }
}

/** Why `url` is not reached, with `protocol` and the ports allowed; null when it may be. */
function refusal(url: string, protocol: string, ports: readonly string[] | null): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "not a URL";
  }
  if (parsed.protocol !== protocol) return `not ${protocol.slice(0, -1)}`;
  // A URL's default port is written "" (443 for https and wss).
  if (ports && !ports.includes(parsed.port)) return `port ${parsed.port} not allowed`;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  // A literal address is not looked up: checked here.
  if (isIP(host) !== 0 && !isPublicAddress(host)) return "not a public address";
  return null;
}

/** The connections of HTTP requests: to public addresses only. */
let agent: Agent | null = null;

/** fetch, to public addresses only, over https (a refused URL rejects as fetch does, a TypeError). */
export const publicFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const refused = refusal(url, "https:", null);
  if (refused) throw new TypeError("fetch failed", { cause: new EgressRefused(url, refused) });
  agent ??= new Agent({ connect: { lookup: publicLookup } });
  return undiciFetch(url, { ...init, dispatcher: agent });
};

/**
 * A WebSocket to a relay, as the vendored nodeWebSocket opens it (its options, unchanged), to a
 * public address only, over wss on port 443. Throws EgressRefused (the pool's failed connection).
 */
export function publicWebSocket(url: string, timeoutMs: number): WebSocketLike {
  const refused = refusal(url, "wss:", ["", "443"]);
  if (refused) throw new EgressRefused(url, refused);
  return new WsWebSocket(url, {
    maxPayload: MAX_RELAY_MESSAGE_BYTES,
    handshakeTimeout: timeoutMs,
    followRedirects: false,
    perMessageDeflate: false,
    headers: { "User-Agent": USER_AGENT },
    lookup: publicLookup
  });
}

/** The services of the hosted server's calls: realServices, reaching public addresses only. */
export function hostedServices(timeoutMs = 10_000, signal?: AbortSignal): Services {
  return {
    ...realServices(timeoutMs, signal),
    createSocket: (url) => publicWebSocket(url, timeoutMs),
    fetch: publicFetch,
    publicOnly: true
  };
}
