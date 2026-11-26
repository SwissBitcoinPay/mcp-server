import { utf8ToBytes } from "@noble/hashes/utils.js";

import { readJson } from "../json.js";
import { RECORD_BLOCK_BYTES, RECORD_KIND } from "../protocol.js";
import { secureRandomBytes, type RandomBytes } from "../random.js";
import { isHex32, isObject } from "../text.js";

import {
  hasValidId,
  isValidEvent,
  nip01Members,
  signatureChecks,
  signEvent,
  type NostrEvent
} from "./event.js";
import { UnknownNip44VersionError, nip44Decrypt, nip44Encrypt } from "./nip44.js";
import type { Keep } from "./relay.js";

/*
 * Sealed records, as the merchant's app writes and reads them: one addressable event
 * of kind 30078 (NIP-78), an opaque `d` tag, NIP-44 v2 content whose plaintext
 * `{"t": <type>, "v": <value>}` is padded with spaces to a multiple of 256 bytes (SPEC.md,
 * "Sealed records").
 */

/** A record of a newer format than this package reads: ignored, never written over. */
export class NewerRecordError extends Error {
  constructor() {
    super("Record of a newer format");
    this.name = "NewerRecordError";
  }
}

export type SealOptions = {
  type: string;
  value: unknown;
  signer: Uint8Array;
  /** NIP-44 conversation key (32 bytes). */
  encryptionKey: Uint8Array;
  /** The `d` tag. */
  address: string;
  /** Unix seconds. */
  createdAt: number;
  /** Tags after the `d` tag: a checkout link's `expiration` (NIP-40). */
  tags?: string[][];
  random?: RandomBytes;
};

/** The signed event of a record. Encryption and signature are randomized. */
export function sealRecord({
  type,
  value,
  signer,
  encryptionKey,
  address,
  createdAt,
  tags = [],
  random = secureRandomBytes
}: SealOptions): NostrEvent {
  const text = JSON.stringify({ t: type, v: value });
  const length = utf8ToBytes(text).length;
  // Spaces after the JSON: ignored when it is parsed.
  const padded =
    text + " ".repeat(Math.ceil(length / RECORD_BLOCK_BYTES) * RECORD_BLOCK_BYTES - length);
  return signEvent(
    {
      kind: RECORD_KIND,
      created_at: createdAt,
      tags: [["d", address], ...tags],
      content: nip44Encrypt(padded, encryptionKey, random)
    },
    signer,
    random
  );
}

export type OpenOptions<T> = {
  type: string;
  encryptionKey: Uint8Array;
  /** The `d` tag the event must have. */
  address: string;
  /** The author the event must have (hex). */
  author: string;
  /** The value, validated (null when invalid). May throw NewerRecordError. */
  parse: (value: unknown, event: NostrEvent) => T | null;
};

export type OpenedRecord<T> =
  | { status: "ok"; event: NostrEvent; value: T }
  /** Authentic, but of a newer format. */
  | { status: "newer"; event: NostrEvent };

/**
 * What a relay sent, if it is a record of `options`: kind, author, `d` tag, then a content that
 * opens with the key and holds a value of the type, then the signature. Anything else is null: a
 * relay is never trusted.
 */
export function openRecord<T>(value: unknown, options: OpenOptions<T>): OpenedRecord<T> | null {
  const claimed = value as Partial<NostrEvent> | null | undefined;
  if (
    claimed?.kind !== RECORD_KIND ||
    claimed.pubkey !== options.author ||
    typeof claimed.content !== "string" ||
    !Array.isArray(claimed.tags) ||
    !claimed.tags.some((tag) => Array.isArray(tag) && tag[0] === "d" && tag[1] === options.address)
  ) {
    return null;
  }
  let payload: unknown = null;
  let newer = false;
  try {
    payload = readContent(claimed.content, options);
  } catch (error) {
    if (!(error instanceof NewerRecordError)) return null;
    newer = true;
  }
  if (!newer && payload === undefined) return null;
  if (!isValidEvent(value)) return null;
  if (newer) return { status: "newer", event: value };
  try {
    const parsed = options.parse(payload, value);
    return parsed === null ? null : { status: "ok", event: value, value: parsed };
  } catch (error) {
    return error instanceof NewerRecordError ? { status: "newer", event: value } : null;
  }
}

/** The value inside a record's content; undefined when it does not open or is of another type. */
function readContent(content: string, options: OpenOptions<unknown>): unknown {
  let text: string;
  try {
    text = nip44Decrypt(content, options.encryptionKey);
  } catch (error) {
    if (error instanceof UnknownNip44VersionError) throw new NewerRecordError();
    return undefined;
  }
  let envelope: unknown;
  try {
    envelope = readJson(text);
  } catch {
    return undefined;
  }
  if (!isObject(envelope) || !("v" in envelope)) return undefined;
  return envelope.t === options.type ? envelope.v : undefined;
}

/**
 * What a read of sealed records keeps of each event (SPEC.md §13: the event, when it opens): an
 * event of kind 30078 whose content decrypts with `keyOf` of its first `d` tag (hex32, else null)
 * and its author (NIP-44 v2, its MAC checked), or is of a newer NIP-44 version, and that checks out
 * (§11). Its signature too: anybody may send a copy of a record under an id of its own, its
 * content and signature left as they are, and only the signature tells it from the record. Checked
 * once per id and signature, whatever relays send copies. `keyOf` gives null for an author or an
 * address the read does not open. Its value is not checked here: the read opens what it keeps. Of
 * the event, only its NIP-01 members are kept: a relay may add any to a record that checks out.
 */
export function recordsThatOpen(
  keyOf: (d: string | null, author: string) => Uint8Array | null
): Keep {
  const verified = new Map<string, boolean>();
  return (value) => {
    if (
      !isObject(value) ||
      value.kind !== RECORD_KIND ||
      typeof value.content !== "string" ||
      typeof value.pubkey !== "string"
    ) {
      return undefined;
    }
    const key = keyOf(dTagOf(value), value.pubkey);
    if (key === null) return undefined;
    try {
      nip44Decrypt(value.content, key);
    } catch (error) {
      if (!(error instanceof UnknownNip44VersionError)) return undefined;
    }
    if (!hasValidId(value)) return undefined;
    const copy = `${value.id}/${value.sig}`;
    let valid = verified.get(copy);
    if (valid === undefined) verified.set(copy, (valid = signatureChecks(value)));
    return valid ? nip01Members(value) : undefined;
  };
}

/** The `d` tag of a value a relay sent, when it is hex32 (its first `d` tag); null otherwise. */
export function dTagOf(value: unknown): string | null {
  const tags = isObject(value) ? value.tags : undefined;
  const tag = Array.isArray(tags)
    ? (tags as unknown[]).find((t) => Array.isArray(t) && t[0] === "d")
    : undefined;
  const d: unknown = Array.isArray(tag) ? tag[1] : undefined;
  return isHex32(d) ? d : null;
}

/** Whether `a` replaces `b` as relays keep them: a later `created_at`, then the lowest id (NIP-01). */
export function replaces(
  a: Pick<NostrEvent, "created_at" | "id">,
  b: Pick<NostrEvent, "created_at" | "id">
): boolean {
  return a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id);
}

/** The newest of the records relays sent. */
export type NewestRecord<T> = {
  newest: { event: NostrEvent; value: T } | null;
  /** `created_at` of the newest copy of a newer format, null when none. */
  newestUnreadable: number | null;
};

/**
 * Reads the answers of queryRelays: every copy is checked with `open`, once per event id that
 * checked out (a copy with the id of one already checked is the same event); the newest by
 * `created_at` wins (on a tie, the lowest event id: the one relays keep, NIP-01).
 */
export function newestRecord<T>(
  answers: ReadonlyMap<string, readonly unknown[]>,
  open: (value: unknown) => OpenedRecord<T> | null
): NewestRecord<T> {
  const checked = new Set<string>();
  let newest: NewestRecord<T>["newest"] = null;
  let newestUnreadable: number | null = null;
  for (const events of answers.values()) {
    for (const value of events) {
      if (isObject(value) && typeof value.id === "string" && checked.has(value.id)) continue;
      const copy = open(value);
      if (!copy) continue;
      checked.add(copy.event.id);
      const createdAt = copy.event.created_at;
      if (copy.status === "newer") {
        newestUnreadable = Math.max(newestUnreadable ?? -1, createdAt);
        continue;
      }
      if (
        !newest ||
        createdAt > newest.event.created_at ||
        (createdAt === newest.event.created_at && copy.event.id < newest.event.id)
      ) {
        newest = { event: copy.event, value: copy.value };
      }
    }
  }
  return { newest, newestUnreadable };
}
