import { bytesToHex } from "@noble/hashes/utils.js";

import { base64UrlToBytes, bytesToBase64Url } from "../../vendor/checkout-node/src/encoding.js";
import { isPublicKey } from "../../vendor/checkout-node/src/nostr/event.js";
import { decodeRelayList } from "../../vendor/checkout-node/src/relays.js";

import { ASSISTANT_KEY_PREFIX } from "./constants.js";

/*
 * An assistant's secret key, as the merchant's app writes it (SPEC.md §3):
 * `sattleme_ak_<team>.<key>.<relays>`, each part canonical base64url without padding, read as an
 * integration key is (spec/SPEC.md §8) with its own prefix. A secret: never in a log, an error, a
 * page, nor a message to the model.
 */

/** What an assistant's secret key holds. */
export type AssistantKey = {
  /** Hex: the team's public key (x only), the author of the channel and of the lot. */
  readonly teamPublicKey: string;
  /**
   * The assistant key (32 bytes). Not enumerable: `JSON.stringify` and `console.log` of this
   * object leave it out.
   */
  readonly key: Uint8Array;
  /** The account's relays when the key was made (`wss://` URLs). */
  readonly relays: readonly string[];
};

/** Not an assistant key: the message never holds the text it was given. */
export class InvalidAssistantKeyError extends Error {
  readonly code = "invalid_key";
  constructor() {
    super("Not a sattle.me assistant key (sattleme_ak_…)");
    this.name = "InvalidAssistantKeyError";
  }
}

/**
 * Reads an assistant's secret key. Throws InvalidAssistantKeyError for anything else: another
 * prefix (an integration's `sattleme_ck_` included), a part too many or missing, a part that is not
 * canonical base64url, a length other than 32 bytes, a team key off the curve, an invalid relay
 * list.
 */
export function parseAssistantKey(text: unknown): AssistantKey {
  if (typeof text !== "string" || !text.startsWith(ASSISTANT_KEY_PREFIX)) {
    throw new InvalidAssistantKeyError();
  }
  const parts = text.slice(ASSISTANT_KEY_PREFIX.length).split(".");
  if (parts.length !== 3) throw new InvalidAssistantKeyError();
  const [teamText, keyText, relaysText] = parts as [string, string, string];
  const team = base64UrlToBytes(teamText);
  const key = base64UrlToBytes(keyText);
  const relays = decodeRelayList(relaysText);
  if (team?.length !== 32 || key?.length !== 32 || relays === null) {
    throw new InvalidAssistantKeyError();
  }
  const teamPublicKey = bytesToHex(team);
  if (!isPublicKey(teamPublicKey)) throw new InvalidAssistantKeyError();
  const parsed = { teamPublicKey, relays: Object.freeze(relays) };
  Object.defineProperty(parsed, "key", { value: key, enumerable: false });
  return Object.freeze(parsed) as AssistantKey;
}

/**
 * A relay list as a key's or a link's third part writes it: the hosts without `wss://`, joined by
 * `,`, in base64url (spec/SPEC.md §8). Every relay of a valid list starts with `wss://`.
 */
export function encodeRelayList(relays: readonly string[]): string {
  const hosts = relays.map((relay) => relay.slice("wss://".length)).join(",");
  return bytesToBase64Url(new TextEncoder().encode(hosts));
}
