import WsWebSocket from "ws";

import type { WebSocketLike } from "./nostr/relay.js";
import { MAX_RELAY_MESSAGE_BYTES, USER_AGENT } from "./protocol.js";

/**
 * A WebSocket to a relay or to the explorer under Node (the `ws` package): a message of 1 MiB at
 * most, the handshake bounded by `timeoutMs`, no redirect followed (SPEC.md §13): a redirect (3xx)
 * is a failed connection, as in HTTP (§15), since it would skip the checks of the URL; and no
 * compression offered (permessage-deflate, which `ws` offers by default): a few compressed bytes
 * would unpack into many large messages, and sealed records do not compress. The handshake carries
 * the User-Agent of every HTTP request (SPEC.md §15): relays behind a bot protection (Cloudflare's)
 * refuse a handshake without one (HTTP 403).
 */
export function nodeWebSocket(url: string, timeoutMs: number): WebSocketLike {
  return new WsWebSocket(url, {
    maxPayload: MAX_RELAY_MESSAGE_BYTES,
    handshakeTimeout: timeoutMs,
    followRedirects: false,
    perMessageDeflate: false,
    headers: { "User-Agent": USER_AGENT }
  });
}
