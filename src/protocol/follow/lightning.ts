import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import {
  openDeclaration,
  type OpenedDeclaration
} from "../../../vendor/checkout-node/src/declaration.js";
import { outerKey, registryAddress, type Sale } from "../../../vendor/checkout-node/src/derive.js";
import type { HttpOptions } from "../../../vendor/checkout-node/src/http.js";
import {
  fetchPayRequest,
  verifyPayment,
  type PayRequest
} from "../../../vendor/checkout-node/src/lnurl.js";
import {
  NewerRecordError,
  openRecord,
  recordsThatOpen
} from "../../../vendor/checkout-node/src/nostr/record.js";
import { majority, type RelayPool } from "../../../vendor/checkout-node/src/nostr/relay.js";
import {
  DECLARATION_RECORD_TYPE,
  RECORD_KIND
} from "../../../vendor/checkout-node/src/protocol.js";

import { SALE_START_TOLERANCE_SECONDS, UNIQUENESS_READ_LIMIT } from "../constants.js";
import { pointEnd, pointHour } from "../points.js";
import { isObject } from "../text.js";

import type { CheckingReason, LightningPayment } from "./verdict.js";

/*
 * The Lightning payments of a sale (SPEC.md §15, "The sale's payments", 1): the invoices the payer's
 * page declared for it in the merchant's registry, each that may pay it checked as the merchant's
 * app checks it (src/lib/registry/registry.ts, checkDeclaredInvoice, datedForSale), paid only with
 * the preimage of its hash from the Lightning address's answer naming it (spec/SPEC.md §22), and
 * counted only when no other sale declared it (paymentUniqueness).
 */

export type LightningRead =
  | { ok: true; payments: LightningPayment[]; openEnds: number[] }
  | { ok: false; reason: CheckingReason };

/** At most this many payment checks at once (as an integration's server). */
const PARALLEL_CHECKS = 4;

async function eachLimited<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_CHECKS, items.length) }, worker));
  return results;
}

/** The host of an https URL, null when it is not one. */
function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Whether d(H) holds a declaration of another sale; null when that cannot be told. */
async function uniqueness(
  pool: RelayPool,
  sale: Sale,
  relays: readonly string[],
  paymentHash: string
): Promise<"unique" | "conflict" | null> {
  const address = registryAddress(sale.registry.key, paymentHash);
  const { answers, answered } = await pool.queryRelays(
    relays,
    { kinds: [RECORD_KIND], "#d": [address], limit: UNIQUENESS_READ_LIMIT },
    sale.secretKey,
    // Every event is kept as sent: how many a relay sent tells whether its answer is whole.
    { paged: false, keep: (value) => value }
  );
  if (!answered) return null;
  let whole = 0;
  for (const events of answers.values()) {
    if (events.length < UNIQUENESS_READ_LIMIT) whole += 1;
    for (const value of events) {
      const author = isObject(value) ? value.pubkey : undefined;
      if (typeof author !== "string" || author === sale.author) continue;
      const opened = openRecord(value, {
        type: DECLARATION_RECORD_TYPE,
        encryptionKey: outerKey(sale.registry.key, address, author),
        address,
        author,
        parse: (outside) => (isObject(outside) && typeof outside.sealed === "string" ? true : null)
      });
      if (opened?.status === "ok") return "conflict";
    }
  }
  return whole >= majority(relays.length) ? "unique" : null;
}

export async function readLightning(
  pool: RelayPool,
  http: HttpOptions,
  sale: Sale,
  relays: readonly string[],
  link: { lightningAddress: string; startsAt: number; endsAt: number },
  now: number
): Promise<LightningRead> {
  const { answers, answered } = await pool.queryRelays(
    relays,
    { kinds: [RECORD_KIND], authors: [sale.author] },
    sale.secretKey,
    {
      paged: true,
      keep: recordsThatOpen((d, author) =>
        author === sale.author && d !== null ? outerKey(sale.registry.key, d, author) : null
      )
    }
  );
  if (!answered) return { ok: false, reason: "relays" };
  const declared = new Map<string, OpenedDeclaration>();
  for (const events of answers.values()) {
    for (const value of events) {
      let opened: OpenedDeclaration | null;
      try {
        opened = openDeclaration(value, sale);
      } catch (error) {
        // A declaration of a newer format: its payment cannot be told here.
        if (error instanceof NewerRecordError) return { ok: false, reason: "payment_check" };
        continue;
      }
      if (opened && !declared.has(opened.decoded.paymentHash)) {
        declared.set(opened.decoded.paymentHash, opened);
      }
    }
  }
  if (declared.size === 0) return { ok: true, payments: [], openEnds: [] };
  let pay: PayRequest;
  try {
    pay = await fetchPayRequest(link.lightningAddress, http);
  } catch {
    return { ok: false, reason: "lightning_address" };
  }
  const metadataHash = bytesToHex(sha256(utf8ToBytes(pay.metadata)));
  const callbackHost = hostOfUrl(pay.callback);
  // Those that may pay the sale: the merchant's Lightning address's, within the sale.
  const candidates = [...declared.values()].filter(({ decoded, verifyUrl }) => {
    const ends = decoded.timestamp + decoded.expirySeconds;
    return (
      hostOfUrl(verifyUrl) === callbackHost &&
      ends <= pointEnd(pointHour(decoded.timestamp)) &&
      decoded.timestamp >= link.startsAt - SALE_START_TOLERANCE_SECONDS &&
      ends <= link.endsAt + SALE_START_TOLERANCE_SECONDS
    );
  });
  type Checked =
    | { kind: "paid"; declaration: OpenedDeclaration; preimage: string }
    | { kind: "open"; ends: number }
    | { kind: "expired" }
    | { kind: "failed"; reason: CheckingReason };
  const checked = await eachLimited(candidates, async (declaration): Promise<Checked> => {
    const { decoded } = declaration;
    const ends = decoded.timestamp + decoded.expirySeconds;
    let part;
    try {
      part = await verifyPayment(
        {
          bolt11: declaration.invoice,
          paymentHash: decoded.paymentHash,
          verifyUrl: declaration.verifyUrl,
          expiresAt: ends
        },
        http,
        now
      );
    } catch {
      return { kind: "failed", reason: "payment_check" };
    }
    if (part.state === "open") return { kind: "open", ends };
    if (part.state === "expired") return { kind: "expired" };
    // Paid, under another description: made under a former name of the business, which the
    // merchant's app accepts and nothing here can tell.
    if (decoded.descriptionHash !== metadataHash) return { kind: "failed", reason: "former_name" };
    return { kind: "paid", declaration, preimage: part.preimage };
  });
  const failed = checked.find((entry) => entry.kind === "failed");
  if (failed) return { ok: false, reason: failed.reason };
  const payments: LightningPayment[] = [];
  for (const entry of checked) {
    if (entry.kind !== "paid") continue;
    const { decoded } = entry.declaration;
    const unique = await uniqueness(pool, sale, relays, decoded.paymentHash);
    if (unique === null) return { ok: false, reason: "uniqueness" };
    if (unique === "conflict") continue;
    payments.push({
      hour: pointHour(decoded.timestamp),
      timestamp: decoded.timestamp,
      sats: decoded.amountMsat! / 1000n,
      paymentHash: decoded.paymentHash,
      preimage: entry.preimage
    });
  }
  return {
    ok: true,
    payments,
    openEnds: checked.flatMap((entry) => (entry.kind === "open" ? [entry.ends] : []))
  };
}
