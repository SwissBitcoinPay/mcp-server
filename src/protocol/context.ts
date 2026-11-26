import type { HttpOptions } from "../../vendor/checkout-node/src/http.js";
import { RelayPool, type WebSocketFactory } from "../../vendor/checkout-node/src/nostr/relay.js";
import { secureRandomBytes, type RandomBytes } from "../../vendor/checkout-node/src/random.js";

/*
 * What a call of the assistant talks through: the relays (one pool per call, released when it is
 * done, spec/SPEC.md §13), HTTP (the Lightning address, CoinGecko, the explorers), the clock and
 * the CSPRNG. Tests give fakes of each; nothing here reaches the network by itself.
 */
export type Services = {
  /** Opens a WebSocket to a relay. */
  createSocket: WebSocketFactory;
  fetch: typeof fetch;
  /** Per request: a relay's page or write, an HTTP request. */
  timeoutMs: number;
  /** Unix seconds. */
  now: () => number;
  random?: RandomBytes;
  signal?: AbortSignal;
  /** The hosted server's: it reaches public addresses only (src/hosted/egress.ts). */
  publicOnly?: boolean;
};

/** One call's connections and options. */
export type Call = {
  pool: RelayPool;
  http: HttpOptions;
  now: () => number;
  random: RandomBytes;
  /** Services' publicOnly: a Bitcoin node that is not of the Internet is not read. */
  publicOnly: boolean;
};

/**
 * Runs `body` with a pool of its own, released once it is done (its writes past a majority go on
 * until their timeout, spec/SPEC.md §13), whatever it ends with.
 */
export async function withCall<T>(
  services: Services,
  body: (call: Call) => Promise<T>
): Promise<T> {
  const random = services.random ?? secureRandomBytes;
  const pool = new RelayPool({
    createSocket: services.createSocket,
    timeoutMs: services.timeoutMs,
    signal: services.signal,
    random,
    now: services.now
  });
  try {
    return await body({
      pool,
      http: { fetch: services.fetch, timeoutMs: services.timeoutMs, signal: services.signal },
      now: services.now,
      random,
      publicOnly: services.publicOnly ?? false
    });
  } finally {
    pool.release();
  }
}
