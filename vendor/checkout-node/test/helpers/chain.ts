/**
 * The blockchain for tests: deposit addresses (taproot, bech32m) made from a seed, and fakes of
 * the explorers (mempool.space and the merchant's Bitcoin node, Esplora REST), of BlockCypher and
 * of the explorer's WebSocket (`track-address`). Never the network.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { WebSocket as WsWebSocket, WebSocketServer } from "ws";

import { BLOCKCYPHER_URL, MEMPOOL_URL } from "../../src/protocol.js";

import type { JsonAnswer } from "./fetch.js";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32M = 0x2bc830a3;

function polymod(values: number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i]!;
  }
  return chk >>> 0;
}

/** The deposit address (`bc1p…`) of a 32-byte program derived from `seed`. */
export function depositAddress(seed: string | number): string {
  const program = sha256(utf8ToBytes(`deposit address ${seed}`));
  const words = [1];
  let accumulator = 0;
  let bits = 0;
  for (const byte of program) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((accumulator >> bits) & 31);
    }
  }
  if (bits > 0) words.push((accumulator << (5 - bits)) & 31);
  const hrp = [..."bc"].map((c) => c.charCodeAt(0));
  const expanded = [...hrp.map((c) => c >> 5), 0, ...hrp.map((c) => c & 31)];
  const mod = polymod([...expanded, ...words, 0, 0, 0, 0, 0, 0]) ^ BECH32M;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >> (5 * (5 - i))) & 31);
  return `bc1${[...words, ...checksum].map((w) => CHARSET[w]).join("")}`;
}

/** A txid made from `seed`. */
export function txid(seed: string | number): string {
  return bytesToHex(sha256(utf8ToBytes(`transaction ${seed}`)));
}

/** A transaction as Esplora writes it. */
export type EsploraTx = {
  txid: string;
  vin: { txid?: string; vout?: number; is_coinbase: boolean }[];
  vout: { value: number; scriptpubkey_address?: string }[];
  status: { confirmed: boolean; block_height?: number };
};

/** A transaction paying `address` `sats`, spending `coins` (`<txid>:<vout>`), and some change. */
export function payment(
  id: string,
  address: string,
  sats: number,
  { coins = [`${txid(`coin of ${id}`)}:0`], height }: { coins?: string[]; height?: number } = {}
): EsploraTx {
  return {
    txid: id,
    vin: coins.map((coin) => {
      const [spent, vout] = coin.split(":");
      return { txid: spent!, vout: Number(vout), is_coinbase: false };
    }),
    vout: [
      { value: sats, scriptpubkey_address: address },
      { value: 5000, scriptpubkey_address: depositAddress("change") }
    ],
    status: height === undefined ? { confirmed: false } : { confirmed: true, block_height: height }
  };
}

/** The explorers and BlockCypher, as a test sets them. */
export class FakeChain {
  /** The chain's height. */
  height = 970_000;
  /** The transactions of each address, in the explorer's order (newest first). */
  readonly txs = new Map<string, EsploraTx[]>();
  /** When BlockCypher received each transaction it knows (RFC 3339). */
  readonly received = new Map<string, string>();
  /**
   * The merchant's Bitcoin node (its URL, as the channel names it), which serves mempool.space's
   * API at `<url>/api` with the same chain; null: none.
   */
  node: string | null = null;
  /**
   * Services that fail: with HTTP 5xx ("mempool", "blockcypher", "node"), or without an answer
   * (the node "unreachable": a server outside the merchant's network).
   */
  readonly down = new Set<"mempool" | "node" | "unreachable" | "blockcypher">();
  /** What was asked, by URL. */
  readonly asked: string[] = [];

  /** Adds `tx` to the transactions of `address`, first (the explorer lists the newest first). */
  add(address: string, tx: EsploraTx) {
    this.txs.set(address, [tx, ...(this.txs.get(address) ?? [])]);
  }

  /** Drops `id` from the mempool (replaced, or dropped). */
  drop(address: string, id: string) {
    this.txs.set(
      address,
      (this.txs.get(address) ?? []).filter((tx) => tx.txid !== id)
    );
  }

  /** Confirms `id` at `height`. */
  confirm(address: string, id: string, height: number) {
    for (const tx of this.txs.get(address) ?? []) {
      if (tx.txid === id) tx.status = { confirmed: true, block_height: height };
    }
  }

  /** The URLs of the node asked. */
  get nodeAsked(): string[] {
    const node = this.node;
    return node === null ? [] : this.asked.filter((href) => href.startsWith(`${node}/api/`));
  }

  /** The URLs of mempool.space asked. */
  get mempoolAsked(): string[] {
    return this.asked.filter((href) => href.startsWith(`${MEMPOOL_URL}/`));
  }

  /** The answer to `url`, or undefined when it is not an explorer's. */
  route(url: URL): JsonAnswer | undefined {
    const href = url.href;
    const node = this.node !== null && href.startsWith(`${this.node}/api/`);
    if (node || href.startsWith(`${MEMPOOL_URL}/`)) {
      this.asked.push(href);
      if (node && this.down.has("unreachable")) throw new TypeError("fetch failed");
      if (this.down.has(node ? "node" : "mempool")) return { status: 503, text: "down" };
      const path = href.slice((node ? `${this.node}/api` : MEMPOOL_URL).length);
      if (path === "/blocks/tip/height") return { text: String(this.height) };
      const address = /^\/address\/([a-z0-9]+)\/txs$/.exec(path);
      if (address) return { json: this.txs.get(address[1]!) ?? [] };
      return { status: 404, text: "Not found" };
    }
    if (href.startsWith(BLOCKCYPHER_URL)) {
      this.asked.push(href);
      if (this.down.has("blockcypher")) return { status: 500, json: { error: "down" } };
      const id = url.pathname.split("/").at(-1)!;
      const received = this.received.get(id);
      return received === undefined
        ? { status: 404, json: { error: `Transaction ${id} not found.` } }
        : { json: { hash: id, received, confirmations: 0 } };
    }
    return undefined;
  }

  /** The URLs of BlockCypher asked. */
  get blockcypherAsked(): string[] {
    return this.asked.filter((href) => href.startsWith(BLOCKCYPHER_URL));
  }
}

/**
 * An explorer's WebSocket for tests (mempool.space's, or a node's): records what each client
 * sends, and pushes what a test says changed.
 */
export class FakeExplorerSocket {
  readonly messages: unknown[] = [];
  connections = 0;

  constructor(readonly server: WebSocketServer) {
    server.on("connection", (socket: WsWebSocket) => {
      this.connections += 1;
      socket.on("message", (data: Buffer) => {
        this.messages.push(JSON.parse(data.toString("utf8")) as unknown);
      });
    });
  }

  /** Pushes `message` to every client. */
  push(message: unknown) {
    for (const client of this.server.clients) client.send(JSON.stringify(message));
  }

  /** Drops every client's connection. */
  drop() {
    for (const client of this.server.clients) client.terminate();
  }
}
