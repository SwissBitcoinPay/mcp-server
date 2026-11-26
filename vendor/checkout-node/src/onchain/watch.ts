import { readJson } from "../json.js";
import type { WebSocketFactory, WebSocketLike } from "../nostr/relay.js";
import { RECONNECT_FIRST_MS, RECONNECT_MAX_MS } from "../protocol.js";
import { isObject } from "../text.js";

import type { ExplorerSource } from "./explorer.js";

/*
 * The explorer's WebSocket (SPEC.md, "Waiting for an on-chain payment"): while waitForPayment
 * waits, the explorer (mempool.space, or the merchant's Bitcoin node) pushes what changes for the
 * address (a transaction entering the mempool, confirmed, or leaving it) and each new block (one
 * more confirmation). Only a signal to check the on-chain part again: what it pushes is never
 * trusted, the check asks the explorer.
 */

/** Which explorers' WebSockets a connection tries, in order, and what hears that the node failed. */
export type WatchedExplorer = {
  /** In order: the next one at once when one fails (explorer.ts, Explorer.sources). */
  sources: () => readonly ExplorerSource[];
  /** A connection to the node failed, or was lost before any message. */
  nodeFailed: () => void;
};

/** The messages that say something changed for the address, or for its confirmations. */
const CHANGES = [
  "address-transactions",
  "block-transactions",
  "address-removed-transactions",
  "block"
];

/** Does nothing: what a socket's handlers become once it is closed. */
const ignore = () => {};

/**
 * Watches `address` on the explorer's WebSocket until `close`: `onChange` is called at each
 * connection (what happened before was not pushed) and at each message about the address or a new
 * block. Each connection tries the WebSockets of `explorer`'s sources in order: one that fails, or
 * is lost before any message, goes to the next at once (the node's to mempool.space's with
 * `fallback` `"mempool"`, SPEC.md §31). A lost socket connects again after 1 s, doubled at each
 * failure (of the last one tried) up to 30 s; a connection lost before it received a message is a
 * failure, so that a server that accepts and drops each connection (each one starts a check) is
 * connected to less and less often.
 */
export function watchAddress(
  createSocket: WebSocketFactory,
  explorer: WatchedExplorer,
  address: string,
  onChange: () => void
): { close: () => void } {
  let closed = false;
  let socket: WebSocketLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = RECONNECT_FIRST_MS;

  const retry = () => {
    if (closed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay);
    delay = Math.min(delay * 2, RECONNECT_MAX_MS);
  };

  /** Connects to the WebSocket of `sources[index]`, the next one at once when it fails. */
  const connectTo = (sources: readonly ExplorerSource[], index: number) => {
    if (closed) return;
    const source = sources[index];
    if (!source) {
      retry();
      return;
    }
    /** It failed, or was lost before any message: the next one at once, or later. */
    const failed = () => {
      if (source.name === "node") explorer.nodeFailed();
      connectTo(sources, index + 1);
    };
    let current: WebSocketLike;
    try {
      current = createSocket(source.webSocket);
    } catch {
      failed();
      return;
    }
    socket = current;
    let lost = false;
    let answered = false;
    const lose = () => {
      if (lost || socket !== current) return;
      lost = true;
      socket = null;
      if (answered) retry();
      else failed();
    };
    current.onopen = () => {
      if (socket !== current) return;
      try {
        current.send(JSON.stringify({ action: "want", data: ["blocks"] }));
        current.send(JSON.stringify({ "track-address": address }));
      } catch {
        lose();
        return;
      }
      onChange();
    };
    current.onmessage = (event: { data: unknown }) => {
      if (socket !== current) return;
      // The explorer answers: the next loss waits 1 s again.
      answered = true;
      delay = RECONNECT_FIRST_MS;
      let message: unknown;
      try {
        message = readJson(String(event.data));
      } catch {
        return;
      }
      if (isObject(message) && CHANGES.some((key) => Object.hasOwn(message, key))) onChange();
    };
    current.onerror = lose;
    current.onclose = lose;
  };

  const connect = () => connectTo(explorer.sources(), 0);

  connect();
  return {
    close: () => {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      const current = socket;
      socket = null;
      if (current) {
        // Never null: the `ws` package emits an "error" when a socket closed while it connects
        // aborts its handshake, and an EventEmitter without a listener throws it.
        current.onmessage = current.onerror = current.onclose = ignore;
        current.onopen = current.readyState === 0 ? () => current.close() : ignore;
        try {
          current.close();
        } catch {
          // Already closed.
        }
      }
    }
  };
}
