import { hexToBytes } from "@noble/hashes/utils.js";

import {
  newestRecord,
  openRecord,
  recordsThatOpen
} from "../../../vendor/checkout-node/src/nostr/record.js";
import { toleranceOf } from "../../../vendor/checkout-node/src/onchain/tolerance.js";
import { RECORD_KIND } from "../../../vendor/checkout-node/src/protocol.js";

import type { Channel } from "../channel.js";
import { LINK_RECORD_TYPE } from "../constants.js";
import type { Call } from "../context.js";
import type { Invoice } from "../invoice.js";
import { linkRecordAddress, type AssistantKeys } from "../keys.js";
import { linkSale, newLinkSecret, type SaleFinal } from "../link.js";
import { PointBook, pointHour } from "../points.js";
import { isObject } from "../text.js";

import { readOnchain } from "./chain.js";
import { readLightning } from "./lightning.js";
import { readAcceptance, readLink } from "./sale.js";
import {
  verdictOf,
  type CheckingReason,
  type LightningPayment,
  type OnchainPayment,
  type Verdict
} from "./verdict.js";

/*
 * Following an invoice's payment (SPEC.md §15): its link's final version when the merchant's app
 * wrote one (it prevails), else the assistant's own verdict from the proofs, as soon as they prove
 * it. What could not be read makes it `checking`, never « unpaid ».
 */

export type PaymentStatus =
  | (Verdict & { source: "proofs" })
  | {
      source: "final";
      state: "paid" | "underpaid" | "expired" | "canceled";
      received: bigint;
      due: bigint | null;
      accepted: boolean;
      method: "lightning" | "onchain" | "mixed" | null;
    };

export type Followed = {
  status: PaymentStatus;
  /** The Lightning payments counted (the final version's, or those proven). */
  lightning: { paymentHash: string; preimage: string; sats: bigint }[];
  /** The transactions paying the address (the final version's, or those read). */
  onchain: { txid: string; sats: bigint; confirmations: number | null }[];
};

function checking(reason: CheckingReason): Followed {
  return { status: { source: "proofs", state: "checking", reason }, lightning: [], onchain: [] };
}

function fromFinal(final: SaleFinal): Followed {
  const hasLightning = final.lightning.length > 0;
  const hasOnchain = final.onchain !== null;
  return {
    status: {
      source: "final",
      state: final.status,
      received: final.received,
      due: final.due,
      accepted: final.accepted,
      method: hasLightning ? (hasOnchain ? "mixed" : "lightning") : hasOnchain ? "onchain" : null
    },
    lightning: final.lightning.map(({ paymentHash, preimage, sats }) => ({
      paymentHash,
      preimage,
      sats
    })),
    onchain: (final.onchain?.transactions ?? []).map(({ txid, sats }) => ({
      txid,
      sats,
      confirmations: null
    }))
  };
}

/** The tolerance the link was made with (its record, SPEC.md §12); undefined when not read. */
async function linkTolerance(
  call: Call,
  keys: AssistantKeys,
  author: string,
  relays: readonly string[]
): Promise<number | undefined> {
  const address = linkRecordAddress(keys, author);
  const by = keys.member.links.publicKey;
  const key = keys.member.records.encryptionKey;
  const { answers, answered } = await call.pool.queryRelays(
    relays,
    { kinds: [RECORD_KIND], authors: [by], "#d": [address] },
    keys.member.links.secretKey,
    {
      paged: false,
      keep: recordsThatOpen((d, author) => (author === by && d === address ? key : null))
    }
  );
  if (!answered) return undefined;
  const { newest } = newestRecord(answers, (value) =>
    openRecord(value, {
      type: LINK_RECORD_TYPE,
      encryptionKey: key,
      address,
      author: by,
      parse: (v) =>
        isObject(v) && v.link === author ? { tolerance: toleranceOf(v.tolerance) } : null
    })
  );
  return newest ? newest.value.tolerance : undefined;
}

export async function followInvoice(
  call: Call,
  keys: AssistantKeys,
  channel: Channel,
  invoice: Invoice
): Promise<Followed> {
  const { id: author, key, relays } = invoice.sent.link;
  const saleKey = hexToBytes(key);
  // The sale's records are read with a key of this read alone, never the assistant's.
  const authKey = newLinkSecret(call.random);
  const link = await readLink(call.pool, relays, author, saleKey, authKey);
  if (!link.ok) return checking("link");
  if (link.final) return fromFinal(link.final);
  const { sale } = link;
  const now = call.now();
  const saleOf = linkSale(saleKey, sale, "");
  const [lightning, onchain, acceptance, tolerance] = await Promise.all([
    readLightning(call.pool, call.http, saleOf, relays, sale, now),
    sale.onchainAddress === null
      ? Promise.resolve({ ok: true as const, payments: [] as OnchainPayment[] })
      : readOnchain(sale.onchainAddress, channel.bitcoinNode, call.http, () => call.now() * 1000),
    readAcceptance(call.pool, relays, sale.owner, saleKey, authKey),
    linkTolerance(call, keys, author, channel.relays)
  ]);
  if (!lightning.ok) return checking(lightning.reason);
  if (!onchain.ok) return checking(onchain.reason);
  if (tolerance === undefined) return checking("relays");
  // A transaction sent after the end: the merchant's app counts it at an hour the assistant cannot
  // bound (a replacement of an earlier one): its final version tells.
  if (onchain.payments.some((tx) => tx.at > sale.endsAt * 1000)) return checking("late_payment");
  const payments: LightningPayment[] = lightning.payments;
  // The points of the hours that decide: from the last payment's to the present, or the sale's end.
  const hours = [
    ...payments.map((paid) => paid.hour),
    ...(onchain.payments.length > 0
      ? [pointHour(Math.floor(Math.max(...onchain.payments.map((tx) => tx.at)) / 1000))]
      : [])
  ];
  const book = new PointBook(sale.fiat.currency, call.http);
  if (hours.length > 0) {
    const first = Math.max(...hours);
    const last = Math.max(first, Math.min(pointHour(now), pointHour(sale.endsAt - 1)));
    try {
      await book.points(first, last, now);
    } catch {
      // What was read stays; an hour not read makes the verdict wait (`price`).
    }
  }
  const verdict = verdictOf({
    now,
    endsAt: sale.endsAt,
    fiat: sale.fiat,
    tolerance,
    lightning: payments,
    openInvoiceEnds: lightning.openEnds,
    onchain: onchain.payments,
    points: book.known,
    acceptance: acceptance ?? null
  });
  // An underpayment the merchant may have accepted: never told while its acceptance is not read.
  if (acceptance === undefined && verdict.state === "underpaid") return checking("relays");
  return {
    status: { ...verdict, source: "proofs" },
    lightning: payments.map(({ paymentHash, preimage, sats }) => ({ paymentHash, preimage, sats })),
    onchain: onchain.payments.map(({ txid, sats, confirmations }) => ({
      txid,
      sats,
      confirmations
    }))
  };
}
