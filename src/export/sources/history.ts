import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import type { NostrEvent } from "../../../vendor/checkout-node/src/nostr/event.js";
import {
  NewerRecordError,
  dTagOf,
  openRecord,
  recordsThatOpen,
  replaces
} from "../../../vendor/checkout-node/src/nostr/record.js";
import { RECORD_KIND } from "../../../vendor/checkout-node/src/protocol.js";

import type { Call } from "../../protocol/context.js";
import { AssistantError } from "../../protocol/errors.js";
import type { Signer } from "../../protocol/keys.js";
import type { ReadKeys } from "../grant.js";
import type { Line } from "../lines.js";

/*
 * The history copied from the merchant's v2 account (SPEC.md §20, The v2 history), as the
 * merchant's app keeps it (its src/lib/legacy-v2/history-records.ts) and lists it among its own
 * movements (its src/features/activity/legacy-history.ts): one copy per month (UTC), in parts, read
 * only once every part of one copy is there, never half a month. For information: no payment of
 * the wallet, its rate the v2 server's.
 */

const PART_TYPE = "legacy-history-month";
const STATE_TYPE = "legacy-history-state";
const MAX_PARTS = 10_000;
const MAX_NOTE_LENGTH = 200;
const HEX_32 = /^[0-9a-f]{64}$/;
const CURRENCY = /^[A-Z]{3}$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** A month ("YYYY-MM") since bitcoin's first, as the app's isMonth. */
const isMonth = (value: unknown): value is string => {
  const match = typeof value === "string" ? MONTH.exec(value) : null;
  return match !== null && Number(match[1]) >= 2009;
};

type Row = {
  ref: string;
  kind: "sale" | "withdraw" | "referral" | "receipt";
  channel: "pos" | "link" | "integration" | null;
  at: number;
  sats: number;
  fiat: { minor: number; digits: number; currency: string } | null;
  note: string;
  rate: { price: number; currency: string } | null;
};

type Part = { month: string; part: number; parts: number; set: string; rows: Row[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isSeconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function rowOf(value: unknown): Row | null {
  if (!isObject(value)) return null;
  const { kind, channel } = value;
  if (kind !== "sale" && kind !== "withdraw" && kind !== "referral" && kind !== "receipt") {
    return null;
  }
  if (
    kind === "sale"
      ? !(channel === "pos" || channel === "link" || channel === "integration")
      : channel !== null
  ) {
    return null;
  }
  if (typeof value.ref !== "string" || !HEX_32.test(value.ref) || !isSeconds(value.at)) return null;
  if (typeof value.sats !== "number" || !Number.isSafeInteger(value.sats) || value.sats < 0) {
    return null;
  }
  if (typeof value.note !== "string" || value.note.length > MAX_NOTE_LENGTH) return null;
  let fiat: Row["fiat"] = null;
  if (value.fiat !== null) {
    if (!isObject(value.fiat)) return null;
    const { minor, digits, currency } = value.fiat;
    if (typeof minor !== "number" || !Number.isSafeInteger(minor) || minor < 0) return null;
    if (typeof digits !== "number" || !Number.isInteger(digits) || digits < 0 || digits > 8) {
      return null;
    }
    if (typeof currency !== "string" || !CURRENCY.test(currency)) return null;
    fiat = { minor, digits, currency };
  }
  let rate: Row["rate"] = null;
  if (value.rate !== null) {
    if (!isObject(value.rate)) return null;
    const { price, currency } = value.rate;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
    if (typeof currency !== "string" || !CURRENCY.test(currency)) return null;
    rate = { price, currency };
  }
  return {
    ref: value.ref,
    kind,
    channel: channel as Row["channel"],
    at: value.at,
    sats: value.sats,
    fiat,
    note: value.note,
    rate
  };
}

function partOf(value: unknown): Part | null {
  if (!isObject(value)) return null;
  if (typeof value.version === "number" && value.version > 1) throw new NewerRecordError();
  const { month, parts, part, set, rows } = value;
  if (
    value.version !== 1 ||
    !isMonth(month) ||
    typeof parts !== "number" ||
    !Number.isSafeInteger(parts) ||
    parts < 1 ||
    parts > MAX_PARTS ||
    typeof part !== "number" ||
    !Number.isSafeInteger(part) ||
    part < 0 ||
    part >= parts ||
    typeof set !== "string" ||
    !HEX_32.test(set) ||
    !Array.isArray(rows) ||
    rows.length === 0
  ) {
    return null;
  }
  const read: Row[] = [];
  for (const entry of rows as unknown[]) {
    const row = rowOf(entry);
    // Ascending, each row once: as the app writes them.
    if (!row || (read.length > 0 && read[read.length - 1]!.ref >= row.ref)) return null;
    read.push(row);
  }
  return { month, part, parts, set, rows: read };
}

/** The hash of a set of refs (hex): SHA-256 of their bytes, each once, sorted. */
function setDigest(refs: Iterable<string>): string {
  const sorted = [...new Set(refs)].sort();
  return bytesToHex(sha256(concatBytes(...sorted.map((ref) => hexToBytes(ref)))));
}

/** The months (UTC, "YYYY-MM") of the seconds from `start` to `end`. */
export function monthsOf(range: { start: number; end: number }): string[] {
  const months: string[] = [];
  const first = new Date(range.start * 1000);
  let year = first.getUTCFullYear();
  let month = first.getUTCMonth();
  for (;;) {
    const begins = Date.UTC(year, month, 1) / 1000;
    if (begins > range.end) break;
    months.push(`${year}-${String(month + 1).padStart(2, "0")}`);
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  return months;
}

/** The state's value (`done`: when the whole history was copied, null: a copy was started). */
function stateOf(value: unknown): { done: number | null } | null {
  if (!isObject(value)) return null;
  if (typeof value.version === "number" && value.version > 1) throw new NewerRecordError();
  if (value.version !== 1) return null;
  return value.done === null || isSeconds(value.done) ? { done: value.done } : null;
}

/** The line of a v2 history row (the app's legacyHistoryItem). */
function lineOf(row: Row): Line {
  return {
    id: `legacy:${row.ref}`,
    source:
      row.kind === "withdraw" ? "send" : row.kind === "sale" ? (row.channel ?? "pos") : "receive",
    at: row.at,
    note: row.note,
    invoice: null,
    by: null,
    payments: [],
    sats: String(row.sats),
    fiat: row.fiat,
    rate: row.rate ? { currency: row.rate.currency, rate: row.rate.price } : null,
    imported: true,
    acceptance: null
  };
}

/** What the relays hold of the v2 history over a period. */
export type HistoryLines = {
  /** The rows of the months of the period copied whole, dated within it. */
  lines: Line[];
  /**
   * Some of it may be missing: a copy was started and not finished (its state says so), or a month
   * of the period has parts but not every part of one copy. Then the export says so.
   */
  incomplete: boolean;
};

type Newest<T> = { id: string; createdAt: number; value: T | null };

/**
 * The v2 history from `start` to `end` (SPEC.md §20), read as the merchant's app reads it (its
 * historyOf and historyMonth): of each address, the newest copy; a month counts only when every
 * part of one copy is there (the newest at its address, all naming its count and `set`, their rows
 * each once and hashing to it). Throws `network` without a majority's whole answer, `newer` when a
 * month of the period holds a record of a newer format (never an export missing it unsaid).
 */
export async function readHistoryLines(
  call: Call,
  relays: readonly string[],
  keys: ReadKeys,
  auth: Signer,
  range: { start: number; end: number }
): Promise<HistoryLines> {
  const encryptionKey = hexToBytes(keys.encryptionKey);
  const addressKey = hexToBytes(keys.addressKey);
  const addressOf = (subject: string) => bytesToHex(hmac(sha256, addressKey, utf8ToBytes(subject)));
  const partAddress = (month: string, part: number) => addressOf(`history/${month}/${part}`);
  const stateAddress = addressOf("history/state");
  const { answers, answered } = await call.pool.queryRelays(
    relays,
    { kinds: [RECORD_KIND], authors: [keys.author] },
    auth.secretKey,
    {
      paged: true,
      keep: recordsThatOpen((_, author) => (author === keys.author ? encryptionKey : null))
    }
  );
  if (!answered) {
    throw new AssistantError("network", "Fewer than a majority of the merchant's relays answered");
  }
  // Of each address, the newest copy that opens; its value null when of a newer format.
  const parts = new Map<string, Newest<Part>>();
  let state: Newest<{ done: number | null }> | null = null;
  const keepNewest = <T>(
    known: Newest<T> | null | undefined,
    event: NostrEvent,
    value: T | null
  ) =>
    !known || replaces(event, { created_at: known.createdAt, id: known.id })
      ? { id: event.id, createdAt: event.created_at, value }
      : known;
  for (const events of answers.values()) {
    for (const event of events) {
      const d = dTagOf(event);
      if (d === null) continue;
      if (d === stateAddress) {
        const opened = openRecord(event, {
          type: STATE_TYPE,
          encryptionKey,
          address: d,
          author: keys.author,
          parse: stateOf
        });
        if (opened)
          state = keepNewest(state, opened.event, opened.status === "ok" ? opened.value : null);
        continue;
      }
      const opened = openRecord(event, {
        type: PART_TYPE,
        encryptionKey,
        address: d,
        author: keys.author,
        parse: (value) => {
          const part = partOf(value);
          return part && d === partAddress(part.month, part.part) ? part : null;
        }
      });
      if (opened) {
        parts.set(
          d,
          keepNewest(parts.get(d), opened.event, opened.status === "ok" ? opened.value : null)
        );
      }
    }
  }
  // The months the read holds a part of.
  const held = new Set<string>();
  for (const { value } of parts.values()) if (value) held.add(value.month);

  const lines: Line[] = [];
  let incomplete = state !== null && (state.value === null || state.value.done === null);
  for (const month of monthsOf(range)) {
    const first = parts.get(partAddress(month, 0));
    const ranks = first?.value?.parts ?? 1;
    for (let rank = 0; rank < ranks; rank += 1) {
      const known = parts.get(partAddress(month, rank));
      if (known && known.value === null) {
        throw new AssistantError("newer", "A month of the v2 history is of a newer format");
      }
    }
    const whole = wholeMonth(
      month,
      first?.value ?? null,
      (rank) => parts.get(partAddress(month, rank))?.value ?? null
    );
    if (!whole) {
      if (held.has(month)) incomplete = true;
      continue;
    }
    for (const row of whole) {
      if (row.at >= range.start && row.at <= range.end) lines.push(lineOf(row));
    }
  }
  return { lines, incomplete };
}

/** The rows of `month` when every part of `first`'s copy is there; null otherwise. */
function wholeMonth(
  month: string,
  first: Part | null,
  partAt: (rank: number) => Part | null
): Row[] | null {
  if (!first) return null;
  const rows: Row[] = [];
  for (let rank = 0; rank < first.parts; rank += 1) {
    const part = partAt(rank);
    if (!part || part.month !== month || part.parts !== first.parts || part.set !== first.set) {
      return null;
    }
    rows.push(...part.rows);
  }
  const refs = rows.map(({ ref }) => ref);
  return new Set(refs).size === refs.length && setDigest(refs) === first.set ? rows : null;
}
