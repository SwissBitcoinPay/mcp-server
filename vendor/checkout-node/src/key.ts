import { bytesToHex } from "@noble/hashes/utils.js";

import { base64UrlToBytes } from "./encoding.js";
import { InvalidKeyError } from "./errors.js";
import { isPublicKey } from "./nostr/event.js";
import { INTEGRATION_KEY_PREFIX, KEY_BYTES } from "./protocol.js";
import { decodeRelayList } from "./relays.js";

/*
 * An integration's secret key, as the merchant's app writes it (SPEC.md, "The integration key"):
 * `sattleme_ck_<team>.<key>.<relays>`, each part in canonical base64url without padding.
 * It stays on the integrator's server: never in a web page, a repository nor a log.
 */

/** What an integration's secret key holds. */
export type IntegrationKey = {
  /** Hex: the team's public key (x only), the author of the integration's channel. */
  readonly teamPublicKey: string;
  /**
   * The integration's key (32 bytes). Not enumerable: `JSON.stringify` and `console.log` of this
   * object leave it out. Never log it.
   */
  readonly key: Uint8Array;
  /** Where its channel was published when the key was given (`wss://` URLs). */
  readonly relays: readonly string[];
};

/**
 * Reads an integration's secret key. Throws InvalidKeyError for anything else: another prefix
 * (a link holding its parts included), a part too many or missing, a part that is
 * not canonical base64url, a length other than 32 bytes, a team key off the curve, an invalid relay
 * list. The message never holds the key.
 */
export function parseIntegrationKey(text: string): IntegrationKey {
  if (typeof text !== "string" || !text.startsWith(INTEGRATION_KEY_PREFIX)) {
    throw new InvalidKeyError();
  }
  const [teamText, keyText, relaysText, ...rest] = text
    .slice(INTEGRATION_KEY_PREFIX.length)
    .split(".");
  if (teamText === undefined || keyText === undefined || relaysText === undefined) {
    throw new InvalidKeyError("Integration key cut short");
  }
  if (rest.length > 0) throw new InvalidKeyError();
  const team = base64UrlToBytes(teamText);
  const key = base64UrlToBytes(keyText);
  const relays = decodeRelayList(relaysText);
  if (team?.length !== KEY_BYTES || key?.length !== KEY_BYTES || relays === null) {
    throw new InvalidKeyError("Damaged integration key");
  }
  const teamPublicKey = bytesToHex(team);
  if (!isPublicKey(teamPublicKey)) throw new InvalidKeyError("Damaged integration key");
  const parsed = { teamPublicKey, relays: Object.freeze(relays) };
  Object.defineProperty(parsed, "key", { value: key, enumerable: false });
  return Object.freeze(parsed) as IntegrationKey;
}
