import { NetworkError } from "../../../vendor/checkout-node/src/errors.js";
import { getJson, hostOf, type HttpOptions } from "../../../vendor/checkout-node/src/http.js";
import {
  addressTransactions,
  blockcypherMilliseconds,
  chainHeight,
  confirmationsOf,
  Explorer,
  paysTo,
  receivedAt
} from "../../../vendor/checkout-node/src/onchain/explorer.js";
import type { BitcoinNode } from "../../../vendor/checkout-node/src/onchain/node.js";
import { paymentParts } from "../../../vendor/checkout-node/src/onchain/replacements.js";
import { BLOCKCYPHER_URL, MEMPOOL_URL } from "../../../vendor/checkout-node/src/protocol.js";

import { HOUR_SECONDS, MEMPOOL_TIME_MARGIN_SECONDS, POINT_DELAY_SECONDS } from "../constants.js";
import { isHex32, isObject } from "../text.js";

import type { CheckingReason, OnchainPayment } from "./verdict.js";

/*
 * What pays a sale's deposit address (SPEC.md §15, "The sale's payments", 2), and when each payment
 * counts from, as the merchant's app and the payer's page tell it (src/lib/onchain/broadcast-time.ts,
 * src/features/onchain/useOnchainTimes.ts, useReplacedTxs.ts): mempool.space's first sight while in
 * the mempool and away from a change of point, BlockCypher's time otherwise; a replacement (RBF)
 * keeps the time of the payment it replaces for what that one paid (spec/SPEC.md §31,
 * Replacements), the replaced transactions named by mempool.space's history and told by BlockCypher.
 * Anything not told is no guess: the status is `checking`.
 */

/** Versions of a chain read at most in a history (as the app). */
const MAX_VERSIONS = 25;
/** Inputs and outputs BlockCypher gives at most in one answer. */
const DETAILS_LIMIT = 100;

/** Whether `seconds` is within 300 s of a change of point (HH:00:00 to HH:09:59). */
export function nearPointChange(seconds: number): boolean {
  const since = (((seconds - POINT_DELAY_SECONDS) % HOUR_SECONDS) + HOUR_SECONDS) % HOUR_SECONDS;
  return since < MEMPOOL_TIME_MARGIN_SECONDS || since >= HOUR_SECONDS - MEMPOOL_TIME_MARGIN_SECONDS;
}

/** When mempool.space first saw `txid` in its mempool (Unix seconds); null when it does not hold it. */
export async function firstSeen(txid: string, http: HttpOptions): Promise<number | null> {
  const url = `${MEMPOOL_URL}/v1/transaction-times?txId%5B%5D=${txid}`;
  const { ok, status, body } = await getJson(url, http);
  if (!ok) throw new NetworkError(`${hostOf(url)} answered HTTP ${status}`);
  if (!Array.isArray(body) || body.length !== 1)
    throw new NetworkError(`${hostOf(url)}: out of shape`);
  const [seconds] = body as unknown[];
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 0) {
    throw new NetworkError(`${hostOf(url)}: not a time`);
  }
  return seconds === 0 ? null : seconds;
}

/** The transactions mempool.space's history says `txid` replaced, directly or not. */
export async function replacedTxids(txid: string, http: HttpOptions): Promise<string[]> {
  const url = `${MEMPOOL_URL}/v1/tx/${txid}/rbf`;
  const { ok, status, body } = await getJson(url, http);
  if (!ok) throw new NetworkError(`${hostOf(url)} answered HTTP ${status}`);
  const outOfShape = () => new NetworkError(`${hostOf(url)}: out of shape`);
  if (!isObject(body)) throw outOfShape();
  const replaced = new Set<string>();
  const { replacements, replaces } = body;
  if (replacements !== null && replacements !== undefined) {
    let visited = 0;
    let found = false;
    const stack: { value: unknown; under: boolean }[] = [{ value: replacements, under: false }];
    while (stack.length > 0) {
      const { value, under } = stack.pop()!;
      visited += 1;
      if (visited > MAX_VERSIONS) throw outOfShape();
      if (!isObject(value) || !isObject(value.tx) || !isHex32(value.tx.txid)) throw outOfShape();
      if (value.replaces !== undefined && !Array.isArray(value.replaces)) throw outOfShape();
      const ours = value.tx.txid === txid;
      if (ours) found = true;
      else if (under) replaced.add(value.tx.txid);
      for (const child of (value.replaces as unknown[] | undefined) ?? []) {
        stack.push({ value: child, under: under || ours });
      }
    }
    if (!found) replaced.clear();
  }
  if (replaces !== null && replaces !== undefined) {
    if (!Array.isArray(replaces) || replaces.length > MAX_VERSIONS) throw outOfShape();
    for (const other of replaces as unknown[]) {
      if (!isHex32(other)) throw outOfShape();
      replaced.add(other);
    }
  }
  replaced.delete(txid);
  if (replaced.size > MAX_VERSIONS) throw outOfShape();
  return [...replaced];
}

/** What BlockCypher keeps of a transaction for one address; null when it does not know it. */
export async function blockcypherDetails(
  txid: string,
  address: string,
  http: HttpOptions
): Promise<{ receivedAt: number; sats: bigint; inputs: string[] } | null> {
  const url = `${BLOCKCYPHER_URL}/txs/${txid}?limit=${DETAILS_LIMIT}&includeHex=false`;
  const { ok, status, body } = await getJson(url, http);
  if (status === 404) return null;
  if (!ok) throw new NetworkError(`${hostOf(url)} answered HTTP ${status}`);
  const outOfShape = () => new NetworkError(`${hostOf(url)}: out of shape`);
  if (!isObject(body) || body.hash !== txid || typeof body.received !== "string")
    throw outOfShape();
  const time = blockcypherMilliseconds(body.received);
  if (time === null || time <= 0) throw outOfShape();
  if (!Array.isArray(body.inputs) || !Array.isArray(body.outputs)) throw outOfShape();
  const inputs: string[] = [];
  for (const input of body.inputs as unknown[]) {
    if (!isObject(input)) throw outOfShape();
    const { prev_hash: from, output_index: index } = input;
    // A coinbase input spends no coin.
    if (from === undefined) continue;
    if (!isHex32(from) || typeof index !== "number" || !Number.isSafeInteger(index))
      throw outOfShape();
    if (index < 0 || index > 0xffff_ffff) throw outOfShape();
    inputs.push(`${from}:${index}`);
  }
  let sats = 0n;
  for (const output of body.outputs as unknown[]) {
    if (!isObject(output)) throw outOfShape();
    const { value, addresses } = output;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw outOfShape();
    if (addresses !== null && addresses !== undefined && !Array.isArray(addresses))
      throw outOfShape();
    const [to, ...others] = (addresses ?? []) as unknown[];
    if (to === address && others.length === 0) sats += BigInt(value);
  }
  return { receivedAt: time, sats, inputs };
}

/** What the address's payments are, or why they cannot be told yet. */
export type OnchainRead =
  { ok: true; payments: OnchainPayment[] } | { ok: false; reason: CheckingReason };

/**
 * The transactions paying `address` now on the merchant's explorer (its node, else mempool.space),
 * each with its depth and the time it counts from (Unix ms).
 */
export async function readOnchain(
  address: string,
  node: BitcoinNode | null,
  http: HttpOptions,
  nowMs: () => number
): Promise<OnchainRead> {
  const explorer = new Explorer(node, new Map(), nowMs);
  let listed;
  try {
    listed = await explorer.read(http, async (base, h) => {
      const [txs, height] = await Promise.all([
        addressTransactions(base, address, h),
        chainHeight(base, h)
      ]);
      return { txs, height };
    });
  } catch {
    return { ok: false, reason: "explorer" };
  }
  const paying = listed.txs
    .map((tx) => ({
      tx,
      sats: paysTo(tx, address),
      confirmations: confirmationsOf(tx, listed.height)
    }))
    .filter(({ sats }) => sats > 0n);
  if (paying.length === 0) return { ok: true, payments: [] };
  // When each listed transaction was sent.
  const times = new Map<string, number>();
  try {
    for (const { tx, confirmations } of paying) {
      let time: number | null = null;
      if (confirmations === 0) {
        const seen = await firstSeen(tx.txid, http);
        if (seen !== null && !nearPointChange(seen)) time = seen * 1000;
      }
      time ??= await receivedAt(tx.txid, http);
      if (time === null) return { ok: false, reason: "time" };
      times.set(tx.txid, time);
    }
  } catch {
    return { ok: false, reason: "time" };
  }
  try {
    // What they replaced, as BlockCypher keeps it.
    const listedIds = new Set(paying.map(({ tx }) => tx.txid));
    const named = new Set<string>();
    for (const { tx } of paying) {
      for (const txid of await replacedTxids(tx.txid, http)) {
        if (!listedIds.has(txid)) named.add(txid);
      }
    }
    const replaced: { txid: string; sats: bigint; inputs: string[]; at: number }[] = [];
    for (const txid of named) {
      const kept = await blockcypherDetails(txid, address, http);
      if (kept) replaced.push({ txid, sats: kept.sats, inputs: kept.inputs, at: kept.receivedAt });
    }
    const parts = paymentParts([
      ...paying.map(({ tx, sats }) => ({
        txid: tx.txid,
        sats,
        inputs: tx.coins,
        order: times.get(tx.txid)!,
        listed: true
      })),
      ...replaced.map(({ txid, sats, inputs, at }) => ({
        txid,
        sats,
        inputs,
        order: at,
        listed: false
      }))
    ]);
    const timeOf = new Map<string, number>([
      ...times,
      ...replaced.map(({ txid, at }) => [txid, at] as const)
    ]);
    return {
      ok: true,
      payments: paying.map(({ tx, sats, confirmations }) => {
        const sources = (parts.get(tx.txid) ?? []).map((part) => timeOf.get(part.root) ?? 0);
        return { txid: tx.txid, sats, confirmations, at: Math.max(0, ...sources) };
      })
    };
  } catch {
    return { ok: false, reason: "replacements" };
  }
}
