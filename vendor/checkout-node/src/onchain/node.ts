import { MAX_NODE_URL_LENGTH } from "../protocol.js";
import { isObject } from "../text.js";

/*
 * The merchant's Bitcoin node (SPEC.md §31, "The merchant's Bitcoin node"): a node of its own that
 * serves mempool.space's API (an Umbrel, a server of its own), which the channel names
 * (`bitcoinNode`, §14) and the server then reads the blockchain from, rather than from
 * mempool.space. Its URL follows a rule of its own, not the https URL's (§15): `http` is allowed
 * for a host of a local network, and so is an IPv4 address. Nothing is repaired: a URL that is not
 * in its one spelling is no node URL, and the channel then names no node.
 */

/** What the server does when the node does not answer a read. */
export type NodeFallback = "mempool" | "none";

/** The channel's `bitcoinNode`, valid. */
export type BitcoinNode = {
  /** A node URL (parseNodeUrl), as the channel writes it. */
  url: string;
  /** `"mempool"`: the same read of mempool.space; `"none"`: never mempool.space. */
  fallback: NodeFallback;
  /** Whether the pages of checkout links read the node too (a node of the Internet only). */
  payers: boolean;
};

/** The node a checkout link's record names (SPEC.md §30): its URL and its fallback. */
export type RecordNode = { url: string; fallback: NodeFallback };

/** A node URL, checked: where the node is read. */
export type NodeUrl = {
  url: string;
  /** `<url>/api`: the `<explorer>` of SPEC.md §31, Explorers. */
  rest: string;
  /** `<url>` with `ws` for its leading `http`, then `/api/v1/ws`. */
  webSocket: string;
  /** Whether the host is of a local network: a local IPv4 range, or a name under `.local`. */
  local: boolean;
  /** Whether it is a node of the Internet: `https`, and a name whose last label is not `local`. */
  internet: boolean;
};

/**
 * `<scheme>://<host>[:<port>][<path>]`: the host up to `:` or `/` (nothing that may start a user
 * name, a query or a fragment), a port of 1 to 5 digits without a leading zero, a path of visible
 * ASCII. The parts are then checked one by one.
 */
const NODE_URL = /^(https?):\/\/([^/:?#@\\\s]+)(?::([1-9][0-9]{0,4}))?(\/[\x21-\x7e]*)?$/;
/** An IPv4 address: 4 numbers from 0 to 255, none with a leading zero. */
const OCTET = "(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const IPV4 = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);
/** A label of a name: 1 to 63 of `a–z 0–9 -`, neither starting nor ending with `-`. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A name's length, at most. */
const MAX_NAME_LENGTH = 253;

/** The four numbers of an IPv4 address, null when `host` is not one. */
function ipv4Of(host: string): number[] | null {
  const match = IPV4.exec(host);
  return match ? match.slice(1, 5).map(Number) : null;
}

/** Whether an IPv4 address is of a local range: 10/8, 172.16/12, 192.168/16, 100.64/10. */
function isLocalIpv4([a, b]: number[]): boolean {
  return (
    a === 10 ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b! >= 64 && b! <= 127)
  );
}

/** Whether `host` is a name: 2 labels or more, the last starting with a letter, no `localhost`. */
function isName(host: string): boolean {
  if (host.length > MAX_NAME_LENGTH) return false;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return false;
  return /^[a-z]/.test(labels.at(-1)!) && labels.at(-1) !== "localhost";
}

/** Whether `path` (after the authority, empty when absent) is a node URL's. */
function isNodePath(path: string): boolean {
  if (path === "") return true;
  // Visible ASCII already; never `?`, `#`, `@` nor `\`.
  if (/[?#@\\]/.test(path)) return false;
  // The node's URL, not its API's: not `/` alone, no trailing `/`, no `/api` at the end.
  return !path.endsWith("/") && !/\/api$/i.test(path);
}

/**
 * `value` as a node URL (SPEC.md §31, "A node URL"), with where the node is read; null when it is
 * not one. `https`, or `http` for a local host; a host in lowercase, an IPv4 address (never in
 * 0.0.0.0/8 nor 127.0.0.0/8) or a name (never `localhost` nor under it); a port from 1 to 65535;
 * a path that ends neither with `/` nor with `/api`; 200 characters at most. So no user name nor
 * password, no query, no fragment, no IPv6 address, no whitespace.
 */
export function parseNodeUrl(value: unknown): NodeUrl | null {
  if (typeof value !== "string" || value.length > MAX_NODE_URL_LENGTH) return null;
  const match = NODE_URL.exec(value);
  if (!match) return null;
  const [, scheme, host, port, path = ""] = match as unknown as [
    string,
    "http" | "https",
    string,
    string | undefined,
    string | undefined
  ];
  if (port !== undefined && Number(port) > 65535) return null;
  if (!isNodePath(path)) return null;
  const ipv4 = ipv4Of(host);
  let local: boolean;
  if (ipv4) {
    // Never the machine itself, nor "this network".
    if (ipv4[0] === 0 || ipv4[0] === 127) return null;
    local = isLocalIpv4(ipv4);
  } else {
    if (!isName(host)) return null;
    local = host.endsWith(".local");
  }
  if (scheme === "http" && !local) return null;
  return {
    url: value,
    rest: `${value}/api`,
    webSocket: `ws${value.slice("http".length)}/api/v1/ws`,
    local,
    internet: scheme === "https" && ipv4 === null && !local
  };
}

/** Whether `value` is `"mempool"` or `"none"`, exactly. */
function isFallback(value: unknown): value is NodeFallback {
  return value === "mempool" || value === "none";
}

/**
 * The channel's `bitcoinNode` (SPEC.md §14, §31): an object whose `url` is a node URL, whose
 * `fallback` is exactly `"mempool"` or `"none"` and whose `payers` is a boolean, `true` only for
 * a node of the Internet; its other members ignored. Null when it is absent or invalid in any
 * way: there is none, the server reads mempool.space, and the channel stays valid.
 */
export function bitcoinNodeOf(value: unknown): BitcoinNode | null {
  if (!isObject(value)) return null;
  const { url, fallback, payers } = value;
  const node = parseNodeUrl(url);
  if (!node || !isFallback(fallback) || typeof payers !== "boolean") return null;
  // A link must never make each customer's browser probe its own local network.
  if (payers && !node.internet) return null;
  return { url: node.url, fallback, payers };
}

/**
 * What a checkout link's record of version 2 holds of `node` (SPEC.md §30): its `url` and
 * `fallback`, copied as they are, never `payers`; null (the field absent) when the channel names
 * no node or its `payers` is false.
 */
export function recordNodeFor(node: BitcoinNode | null): RecordNode | null {
  return node?.payers ? { url: node.url, fallback: node.fallback } : null;
}

/**
 * The node a page reads from a record of version 2's `bitcoinNode` (SPEC.md §30, "Reading a
 * record"): an object whose `url` is a node URL of a node of the Internet and whose `fallback` is
 * exactly `"mempool"` or `"none"` (its other members ignored); anything else (`null` included) is
 * set aside, the page reading mempool.space, and leaves the record valid.
 */
export function recordNodeOf(value: unknown): RecordNode | null {
  if (!isObject(value)) return null;
  const { url, fallback } = value;
  const node = parseNodeUrl(url);
  if (!node?.internet || !isFallback(fallback)) return null;
  return { url: node.url, fallback };
}
