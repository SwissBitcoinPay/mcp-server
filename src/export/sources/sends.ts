import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import {
  NewerRecordError,
  openRecord,
  recordsThatOpen,
  replaces
} from "../../../vendor/checkout-node/src/nostr/record.js";
import { RECORD_KIND } from "../../../vendor/checkout-node/src/protocol.js";

import type { Call } from "../../protocol/context.js";
import { AssistantError } from "../../protocol/errors.js";
import type { Signer } from "../../protocol/keys.js";
import { pointHour } from "../../protocol/points.js";
import type { ReadKeys } from "../grant.js";
import type { Line } from "../lines.js";

/*
 * The payments the merchant's wallet sent (SPEC.md §20, Sendings), as the merchant's app publishes
 * them as soon as it makes them (its src/lib/wallet-sends/record.ts), with the price of bitcoin it
 * recorded at each (its src/lib/rates/payment-rates.ts): the lines « Envoi » of the export. A
 * sending made outside the app (the recovery phrase in another wallet) is not there.
 */

const SEND_TYPE = "wallet-send";
const RATE_TYPE = "payment-rate";
const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 1000;
const SATS = /^(0|[1-9][0-9]{0,15})$/;
const NETWORKS = ["lightning", "bitcoin", "spark", "unknown"] as const;
type Network = (typeof NETWORKS)[number];

type Send = {
  payment: string;
  at: number;
  sats: string;
  feeSats: string;
  network: Network;
  reference: string;
  text: string | null;
};

type Rate = { payment: string; at: number; currency: string; hour: number; rate: number };

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const isUnixSeconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function address(keys: ReadKeys, subject: string): string {
  return bytesToHex(hmac(sha256, hexToBytes(keys.addressKey), utf8ToBytes(subject)));
}

function sendOf(value: unknown): Send | null {
  if (!isObject(value)) return null;
  if (typeof value.version === "number" && value.version > 1) throw new NewerRecordError();
  if (
    value.version !== 1 ||
    !isText(value.payment, MAX_ID_LENGTH) ||
    !isUnixSeconds(value.at) ||
    typeof value.sats !== "string" ||
    !SATS.test(value.sats) ||
    typeof value.feeSats !== "string" ||
    !SATS.test(value.feeSats) ||
    !(NETWORKS as readonly unknown[]).includes(value.network) ||
    !isText(value.reference, MAX_ID_LENGTH) ||
    !(value.text === null || isText(value.text, MAX_TEXT_LENGTH))
  ) {
    return null;
  }
  return {
    payment: value.payment,
    at: value.at,
    sats: value.sats,
    feeSats: value.feeSats,
    network: value.network as Network,
    reference: value.reference,
    text: value.text
  };
}

function rateOf(value: unknown): Rate | null {
  if (!isObject(value)) return null;
  if (typeof value.version === "number" && value.version > 1) throw new NewerRecordError();
  if (
    value.version !== 1 ||
    !isText(value.payment, MAX_ID_LENGTH) ||
    !isUnixSeconds(value.at) ||
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.currency) ||
    value.currency === "BTC" ||
    !isUnixSeconds(value.hour) ||
    value.hour !== pointHour(value.at) ||
    typeof value.rate !== "number" ||
    !Number.isFinite(value.rate) ||
    value.rate <= 0
  ) {
    return null;
  }
  return {
    payment: value.payment,
    at: value.at,
    currency: value.currency,
    hour: value.hour,
    rate: value.rate
  };
}

/**
 * The records of `type` by `keys`' author from `start` to `end`, each opened and checked against
 * its address (`subject` of its value) and its date (its value's `at`); of two copies of one
 * payment, the one relays keep. Throws `network` without a majority's whole answer.
 */
async function readRecords<T extends { payment: string; at: number }>(
  call: Call,
  relays: readonly string[],
  keys: ReadKeys,
  auth: Signer,
  range: { start: number; end: number },
  type: string,
  parse: (value: unknown) => T | null,
  prefix: string
): Promise<Map<string, T>> {
  const encryptionKey = hexToBytes(keys.encryptionKey);
  const { answers, answered } = await call.pool.queryRelays(
    relays,
    { kinds: [RECORD_KIND], authors: [keys.author], since: range.start, until: range.end },
    auth.secretKey,
    {
      paged: true,
      keep: recordsThatOpen((_, author) => (author === keys.author ? encryptionKey : null))
    }
  );
  if (!answered) {
    throw new AssistantError("network", "Fewer than a majority of the merchant's relays answered");
  }
  const found = new Map<string, { value: T; id: string; createdAt: number }>();
  const seen = new Set<string>();
  for (const events of answers.values()) {
    for (const event of events) {
      const id = isObject(event) && typeof event.id === "string" ? event.id : null;
      if (id !== null && seen.has(id)) continue;
      if (id !== null) seen.add(id);
      const d = isObject(event) && Array.isArray(event.tags) ? event.tags : [];
      const tag = (d as unknown[]).find(
        (t): t is [string, string] => Array.isArray(t) && t[0] === "d" && typeof t[1] === "string"
      );
      if (!tag) continue;
      const opened = openRecord(event, {
        type,
        encryptionKey,
        address: tag[1],
        author: keys.author,
        parse: (value, ev) => {
          const parsed = parse(value);
          return parsed &&
            ev.created_at === parsed.at &&
            tag[1] === address(keys, `${prefix}/${parsed.payment}`)
            ? parsed
            : null;
        }
      });
      if (!opened || opened.status !== "ok") continue;
      const known = found.get(opened.value.payment);
      if (!known || replaces(opened.event, { created_at: known.createdAt, id: known.id })) {
        found.set(opened.value.payment, {
          value: opened.value,
          id: opened.event.id,
          createdAt: opened.event.created_at
        });
      }
    }
  }
  return new Map([...found].map(([payment, { value }]) => [payment, value]));
}

/**
 * The lines « Envoi » of the payments the wallet sent from `start` to `end`, each with the rate
 * recorded at its payment (none when none was recorded).
 */
export async function readSendLines(
  call: Call,
  relays: readonly string[],
  keys: { walletSends: ReadKeys; paymentRates: ReadKeys },
  auth: Signer,
  range: { start: number; end: number }
): Promise<Line[]> {
  const [sends, rates] = await Promise.all([
    readRecords(call, relays, keys.walletSends, auth, range, SEND_TYPE, sendOf, "wallet-send"),
    readRecords(call, relays, keys.paymentRates, auth, range, RATE_TYPE, rateOf, "payment-rate")
  ]);
  return [...sends.values()].map((send): Line => {
    const rate = rates.get(send.payment);
    const lightning = send.network === "lightning" || send.network === "spark";
    return {
      id: send.payment,
      source: "send",
      at: send.at,
      note: "",
      invoice: null,
      by: null,
      payments: [
        {
          id: send.payment,
          direction: "send",
          status: "completed",
          amountSats: send.sats,
          feeSats: send.feeSats,
          timestamp: send.at,
          network: send.network,
          // The reference the app wrote (its payment hash, else its transaction, else its id).
          paymentHash: lightning && send.reference !== send.payment ? send.reference : null,
          txId: !lightning && send.reference !== send.payment ? send.reference : null,
          lightningAddress: lightning ? send.text : null,
          description: null
        }
      ],
      sats: send.sats,
      fiat: null,
      rate: rate ? { currency: rate.currency, rate: rate.rate } : null,
      imported: false,
      acceptance: null
    };
  });
}
