import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import { secureRandomBytes, type RandomBytes } from "../random.js";
import { isHex32, isHex64, isWellFormed } from "../text.js";

/** A signed Nostr event (NIP-01). */
export type NostrEvent = {
  /** Hex SHA-256 of the serialized event. */
  id: string;
  /** Hex x-only public key of the author. */
  pubkey: string;
  /** Unix seconds. */
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  /** Hex BIP-340 signature of `id`. */
  sig: string;
};

export type EventTemplate = Pick<NostrEvent, "created_at" | "kind" | "tags" | "content">;

/** The event id: SHA-256 of the NIP-01 serialization. */
function eventHash(pubkey: string, { created_at, kind, tags, content }: EventTemplate) {
  return sha256(utf8ToBytes(JSON.stringify([0, pubkey, created_at, kind, tags, content])));
}

/** The id an event of `pubkey` must have (hex): its hash (SPEC.md §11). */
export function eventId(pubkey: string, template: EventTemplate): string {
  return bytesToHex(eventHash(pubkey, template));
}

/** The x-only public key (hex) of a BIP-340 secret key. */
export function publicKeyOf(secretKey: Uint8Array): string {
  return bytesToHex(schnorr.getPublicKey(secretKey));
}

/** Whether `value` is an x-only public key (lowercase hex) of a point of secp256k1 (BIP-340). */
export function isPublicKey(value: unknown): value is string {
  if (!isHex32(value)) return false;
  try {
    secp256k1.Point.fromHex(`02${value}`);
    return true;
  } catch {
    return false;
  }
}

/** Signs `template` (BIP-340, fresh auxiliary random data as the BIP recommends). */
export function signEvent(
  template: EventTemplate,
  secretKey: Uint8Array,
  random: RandomBytes = secureRandomBytes
): NostrEvent {
  const pubkey = publicKeyOf(secretKey);
  const hash = eventHash(pubkey, template);
  return {
    ...template,
    id: bytesToHex(hash),
    pubkey,
    sig: bytesToHex(schnorr.sign(hash, secretKey, random(32)))
  };
}

/** Whether `value` is an event whose id and signature check out. Relays are never trusted. */
export function isValidEvent(value: unknown): value is NostrEvent {
  return hasValidId(value) && signatureChecks(value);
}

/**
 * Whether `value` has the shape of an event and its id is its hash: what is checked of a record
 * before anything else where anybody may write (SPEC.md, "Opening a lease"), its signature only
 * where it decides. A string of its content or tags holding a lone surrogate has no UTF-8, which
 * its hash needs: such an event does not check out (TextEncoder would hash U+FFFD in its place).
 */
export function hasValidId(value: unknown): value is NostrEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  if (
    !isHex32(event.id) ||
    !isHex32(event.pubkey) ||
    !isHex64(event.sig) ||
    typeof event.created_at !== "number" ||
    !Number.isSafeInteger(event.created_at) ||
    typeof event.kind !== "number" ||
    !Number.isInteger(event.kind) ||
    typeof event.content !== "string" ||
    !isWellFormed(event.content) ||
    !Array.isArray(event.tags) ||
    !event.tags.every(
      (tag) =>
        Array.isArray(tag) && tag.every((item) => typeof item === "string" && isWellFormed(item))
    )
  ) {
    return false;
  }
  const valid = event as unknown as NostrEvent;
  return eventId(valid.pubkey, valid) === valid.id;
}

/**
 * The NIP-01 members of `event`, which checked out, and nothing else: what a relay adds to an event
 * (its id and its signature cover none of it) is never kept (SPEC.md §13, "Limits").
 */
export function nip01Members({
  id,
  pubkey,
  created_at,
  kind,
  tags,
  content,
  sig
}: NostrEvent): NostrEvent {
  return { id, pubkey, created_at, kind, tags, content, sig };
}

/** Whether the signature of `event`, whose id was checked, verifies (BIP-340). */
export function signatureChecks(event: Pick<NostrEvent, "id" | "pubkey" | "sig">): boolean {
  try {
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}
