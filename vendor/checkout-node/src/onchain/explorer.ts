import { NetworkError } from "../errors.js";
import { getJson, getText, hostOf, type HttpOptions } from "../http.js";
import {
  BLOCKCYPHER_URL,
  MAX_SATS,
  MEMPOOL_URL,
  MEMPOOL_WEBSOCKET_URL,
  NODE_FAILED_RECENTLY_MS
} from "../protocol.js";
import { isHex32, isObject } from "../text.js";

import { parseNodeUrl, type BitcoinNode, type NodeFallback } from "./node.js";

/*
 * What the blockchain shows (SPEC.md §31, "Explorers"): one explorer of the Esplora API, the
 * explorer, asked over HTTP: mempool.space, or the merchant's Bitcoin node when the channel names
 * one (node.ts), mempool.space answering in its place when the node fails and its `fallback` is
 * `"mempool"`; and BlockCypher, for when a transaction was received, asked only about a
 * transaction no check saw while its lease ran. Third parties: they see the server's IP address
 * and what it asks about, never a key. Their answers are checked as strictly as a relay's:
 * anything else is a failure (NetworkError). A payment counts as made on what the explorer read
 * alone shows.
 */

/** A transaction, as an explorer gives it, checked. */
export type ExplorerTx = {
  txid: string;
  /** The coins it spends (`<txid>:<vout>`), coinbase inputs left out, in their order. */
  coins: string[];
  outputs: { sats: bigint; address: string | null }[];
  /** The height of its block; null while it is not confirmed. */
  blockHeight: number | null;
};

const MAX_VOUT = 4_294_967_295;

function isSafeNatural(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** An Esplora transaction, checked; null when it is not one. */
export function parseTransaction(value: unknown): ExplorerTx | null {
  if (!isObject(value) || !isHex32(value.txid)) return null;
  const { vin, vout, status } = value;
  if (!Array.isArray(vin) || !Array.isArray(vout) || !isObject(status)) return null;
  const coins: string[] = [];
  for (const input of vin as unknown[]) {
    if (!isObject(input)) return null;
    if (input.is_coinbase === true) continue;
    const { txid, vout: index } = input;
    if (!isHex32(txid) || !isSafeNatural(index) || index > MAX_VOUT) return null;
    coins.push(`${txid}:${index}`);
  }
  const outputs: ExplorerTx["outputs"] = [];
  for (const output of vout as unknown[]) {
    if (!isObject(output) || !isSafeNatural(output.value)) return null;
    const address = output.scriptpubkey_address;
    if (address !== undefined && typeof address !== "string") return null;
    outputs.push({ sats: BigInt(output.value), address: address ?? null });
  }
  // More than every bitcoin there will ever be: no transaction, whatever an explorer says.
  if (outputs.reduce((sum, output) => sum + output.sats, 0n) > MAX_SATS) return null;
  if (typeof status.confirmed !== "boolean") return null;
  let blockHeight: number | null = null;
  if (status.confirmed) {
    if (!isSafeNatural(status.block_height)) return null;
    blockHeight = status.block_height;
  }
  return { txid: value.txid, coins, outputs, blockHeight };
}

/** What `tx` pays `address`: the sum of its outputs to it. */
export function paysTo(tx: ExplorerTx, address: string): bigint {
  return tx.outputs.reduce(
    (sum, output) => (output.address === address ? sum + output.sats : sum),
    0n
  );
}

/** Its confirmations at the chain's `height`: 0 unconfirmed, else height − its block's + 1, 1 at least. */
export function confirmationsOf(tx: ExplorerTx, height: number): number {
  return tx.blockHeight === null ? 0 : Math.max(1, height - tx.blockHeight + 1);
}

/**
 * The transactions of `address` on the explorer at `base`: its first answer (a deposit address is
 * paid a few times at most), in the explorer's order.
 */
export async function addressTransactions(
  base: string,
  address: string,
  http: HttpOptions
): Promise<ExplorerTx[]> {
  const url = `${base}/address/${address}/txs`;
  const { ok, status, body } = await getJson(url, http);
  if (!ok) throw new NetworkError(`${hostOf(url)} answered HTTP ${status}`);
  if (!Array.isArray(body)) throw new NetworkError(`${hostOf(url)} gave no transactions`);
  const txs: ExplorerTx[] = [];
  for (const value of body as unknown[]) {
    const tx = parseTransaction(value);
    if (!tx) throw new NetworkError(`${hostOf(url)} gave a transaction that is not one`);
    txs.push(tx);
  }
  return txs;
}

/** The chain's height on the explorer at `base`: a body of 1 to 9 digits (plain text, not JSON). */
export async function chainHeight(base: string, http: HttpOptions): Promise<number> {
  const url = `${base}/blocks/tip/height`;
  const { ok, status, text } = await getText(url, http);
  if (!ok) throw new NetworkError(`${hostOf(url)} answered HTTP ${status}`);
  if (text === null || !/^[0-9]{1,9}$/.test(text)) {
    throw new NetworkError(`${hostOf(url)} gave no height`);
  }
  return Number(text);
}

/**
 * A time as BlockCypher writes it: UTC, a fraction of 1 to 9 digits or none, `Z`
 * (`2026-10-10T13:05:12.345Z`). Another spelling of RFC 3339 is not BlockCypher's.
 */
const BLOCKCYPHER_TIME =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?Z$/;

/**
 * Unix milliseconds of a time as BlockCypher writes it, the fraction past milliseconds dropped
 * (never rounded), or null when it is not one, or not a real date and time (a month of 01 to 12, a
 * day of that month, hours 00 to 23, minutes and seconds 00 to 59: no leap second).
 */
export function blockcypherMilliseconds(text: string): number | null {
  const match = BLOCKCYPHER_TIME.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number
  ];
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  // Not Date.UTC: it reads the years 0 to 99 as 1900 to 1999.
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour, minute, second, Number((match[7] ?? "").slice(0, 3).padEnd(3, "0")));
  // An overflowing day is carried over to the next month: a day that is not one.
  if (day < 1 || utc.getUTCDate() !== day) return null;
  return utc.getTime();
}

/**
 * When BlockCypher first received `txid`, in Unix milliseconds (it never changes); null when it
 * does not know it yet (HTTP 404: it receives it later). Without a token, BlockCypher takes 100
 * requests an hour from an IP address: it is asked only about a transaction no check saw in time.
 */
export async function receivedAt(txid: string, http: HttpOptions): Promise<number | null> {
  const url = `${BLOCKCYPHER_URL}/txs/${txid}?limit=1&includeHex=false`;
  const { ok, status, body } = await getJson(url, http);
  if (status === 404) return null;
  if (!ok) throw new NetworkError(`${hostOf(url)} answered HTTP ${status}`);
  if (!isObject(body) || body.hash !== txid || typeof body.received !== "string") {
    throw new NetworkError(`${hostOf(url)} gave no time for the transaction`);
  }
  const time = blockcypherMilliseconds(body.received);
  if (time === null || time <= 0) {
    throw new NetworkError(`${hostOf(url)} gave no time for the transaction`);
  }
  return time;
}

/** An explorer a read may ask: the merchant's Bitcoin node, or mempool.space. */
export type ExplorerName = "node" | "mempool";

/**
 * The explorers one read asks, in order (SPEC.md §31, `fallback`): without a node, mempool.space;
 * with `"none"`, the node alone; with `"mempool"`, the node then mempool.space, or mempool.space
 * first when the node failed a read less than 60 s ago in the same call (`failedRecently`). The
 * next one is asked only when the one before failed: a read gives the answer of the first that
 * answers, and fails (NetworkError) when every one asked failed.
 */
export function explorersToAsk(
  node: { fallback: NodeFallback; failedRecently: boolean } | null
): ExplorerName[] {
  if (node === null) return ["mempool"];
  if (node.fallback === "none") return ["node"];
  return node.failedRecently ? ["mempool", "node"] : ["node", "mempool"];
}

/**
 * When the nodes a call read failed a read, by node URL (Unix milliseconds): of one call alone
 * (createInvoice, getStatus, one waitForPayment), never kept between calls.
 */
export type NodeFailures = Map<string, number>;

/** An explorer asked: its name, its REST URL (`<explorer>`) and its WebSocket's. */
export type ExplorerSource = { name: ExplorerName; rest: string; webSocket: string };

const MEMPOOL: ExplorerSource = {
  name: "mempool",
  rest: MEMPOOL_URL,
  webSocket: MEMPOOL_WEBSOCKET_URL
};

/**
 * The explorer of a call (SPEC.md §31): mempool.space, or `node` (the channel's, valid) with its
 * fallback. Each read follows the fallback on its own; a node that fails is remembered in
 * `failures`, which the call's reads share, so that for 60 s it is asked after mempool.space.
 */
export class Explorer {
  readonly #node: (ExplorerSource & { url: string; fallback: NodeFallback }) | null;
  readonly #failures: NodeFailures;
  readonly #now: () => number;

  /** `now`: the clock, in milliseconds. */
  constructor(node: BitcoinNode | null, failures: NodeFailures, now: () => number) {
    const at = node ? parseNodeUrl(node.url) : null;
    this.#node =
      node && at
        ? {
            name: "node",
            rest: at.rest,
            webSocket: at.webSocket,
            url: at.url,
            fallback: node.fallback
          }
        : null;
    this.#failures = failures;
    this.#now = now;
  }

  /** The explorers the next read asks, in order (explorersToAsk). */
  sources(): ExplorerSource[] {
    const node = this.#node;
    if (!node) return [MEMPOOL];
    const failedAt = this.#failures.get(node.url);
    const failedRecently =
      failedAt !== undefined && this.#now() - failedAt < NODE_FAILED_RECENTLY_MS;
    return explorersToAsk({ fallback: node.fallback, failedRecently }).map((name) =>
      name === "node" ? node : MEMPOOL
    );
  }

  /** The node failed a read (or its WebSocket a connection): remembered for the call. */
  nodeFailed(): void {
    if (this.#node) this.#failures.set(this.#node.url, this.#now());
  }

  /**
   * One read of the explorer: `run` with the `<explorer>` URL of each explorer of sources(), in
   * order, until one answers. Each is asked with a signal of its own, aborted once it failed: what
   * `run` asked of it at the same time (the chain's height with the address's transactions) ends
   * then, and the whole read is asked again of the next one, never part of it. NetworkError when
   * every one failed; a cancellation (`http.signal`) is thrown as it is.
   */
  async read<T>(
    http: HttpOptions,
    run: (base: string, http: HttpOptions) => Promise<T>
  ): Promise<T> {
    const failures: NetworkError[] = [];
    for (const source of this.sources()) {
      const attempt = new AbortController();
      const signal = http.signal ? AbortSignal.any([http.signal, attempt.signal]) : attempt.signal;
      try {
        return await run(source.rest, { ...http, signal });
      } catch (error) {
        attempt.abort();
        if (http.signal?.aborted) throw http.signal.reason;
        if (!(error instanceof NetworkError)) throw error;
        if (source.name === "node") this.nodeFailed();
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0]!;
    throw new NetworkError(
      `Neither the merchant's Bitcoin node nor mempool.space answered (${failures
        .map(({ message }) => message)
        .join("; ")})`,
      { cause: failures.at(-1) }
    );
  }
}
