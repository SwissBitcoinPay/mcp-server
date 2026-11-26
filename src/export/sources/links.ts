import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import type { NostrEvent } from "../../../vendor/checkout-node/src/nostr/event.js";
import {
  NewerRecordError,
  dTagOf,
  openRecord,
  recordsThatOpen,
  replaces
} from "../../../vendor/checkout-node/src/nostr/record.js";
import type { BitcoinNode } from "../../../vendor/checkout-node/src/onchain/node.js";
import { CONFIRMATIONS, RECORD_KIND } from "../../../vendor/checkout-node/src/protocol.js";
import { secureRandomBytes } from "../../../vendor/checkout-node/src/random.js";
import { parseRelayList } from "../../../vendor/checkout-node/src/relays.js";

import { LINK_RECORD_TYPE, MAX_SALE_SECONDS } from "../../protocol/constants.js";
import type { Call } from "../../protocol/context.js";
import { AssistantError } from "../../protocol/errors.js";
import { readOnchain } from "../../protocol/follow/chain.js";
import { readLightning } from "../../protocol/follow/lightning.js";
import { readAcceptance, readLink } from "../../protocol/follow/sale.js";
import { formatInvoiceNumber } from "../../protocol/invoice.js";
import type { Signer } from "../../protocol/keys.js";
import { linkSale } from "../../protocol/link.js";
import { readInvoicesOf } from "../../protocol/read.js";
import { isObject } from "../../protocol/text.js";
import type { GrantSeat, ReadKeys } from "../grant.js";
import type { Line, LinePayment } from "../lines.js";

import { SALE_SPAN_SECONDS, identityOf, receivedMinor, type SetAside } from "./till.js";

/*
 * The sales of the payment links (SPEC.md §20, The payment links and the invoices): those the
 * business's devices and assistants made (their `team-link` records, the app's
 * src/lib/team/member-records.ts and SPEC.md §12) and those of the invoices sent (« Nouvelle
 * facture », the merchant's and each assistant's), as « Portefeuille » lists them (the app's
 * linkItem): a link's final version, when its merchant's app wrote one, tells its payments; without
 * it, the payments its proofs prove (a Lightning invoice declared for the sale and paid with its
 * preimage, unique to it; a transaction paying its address, 3 blocks deep). An underpaid final
 * version is a line once the merchant accepted the sale.
 */

/** How many links are followed at once. */
const PARALLEL_LINKS = 4;
const HEX_32 = /^[0-9a-f]{64}$/;

/** A seat whose records hold the links it made, with the keys to read them. */
export type LinkSeat = {
  by: NonNullable<Line["by"]>;
  /** Author of its links' records. */
  author: string;
  encryptionKey: string;
  addressKey: string;
};

/** An author of invoices (the merchant's, an assistant's), and « Par » of their lines. */
export type InvoiceSource = { by: NonNullable<Line["by"]>; reader: ReadKeys };

/** The seats that make links: the owner's devices, the employees, the assistants. */
export function linkSeatsOf(seats: readonly GrantSeat[]): LinkSeat[] {
  return seats.flatMap((seat): LinkSeat[] =>
    seat.role === "integration"
      ? []
      : [
          {
            by: seat.role === "owner" ? { kind: "you" } : { kind: "seat", name: seat.name },
            author: seat.records.links,
            encryptionKey: seat.records.encryptionKey,
            addressKey: seat.records.addressKey
          }
        ]
  );
}

/** The authors of invoices: the merchant's (« Vous ») and each assistant's. */
export function invoiceSourcesOf(owner: ReadKeys, seats: readonly GrantSeat[]): InvoiceSource[] {
  return [
    { by: { kind: "you" }, reader: owner },
    ...seats.flatMap((seat): InvoiceSource[] =>
      seat.role === "assistant"
        ? [{ by: { kind: "seat", name: seat.name }, reader: seat.invoices }]
        : []
    )
  ];
}

/** A link to follow: its author, its sale's key and relays, and who made it. */
type KnownLink = {
  author: string;
  saleKey: string;
  relays: string[];
  createdAt: number;
  by: NonNullable<Line["by"]>;
  invoice: Line["invoice"];
};

/** The `team-link` records of `seats` made from `since` to `until`. */
async function readLinkRecords(
  call: Call,
  relays: readonly string[],
  seats: readonly LinkSeat[],
  auth: Signer,
  window: { start: number; end: number }
): Promise<KnownLink[]> {
  const byAuthor = new Map(seats.map((seat) => [seat.author, seat]));
  if (byAuthor.size === 0) return [];
  const { answers, answered } = await call.pool.queryRelays(
    relays,
    { kinds: [RECORD_KIND], authors: [...byAuthor.keys()], since: window.start, until: window.end },
    auth.secretKey,
    {
      paged: true,
      keep: recordsThatOpen((_, author) => {
        const seat = byAuthor.get(author);
        return seat ? hexToBytes(seat.encryptionKey) : null;
      })
    }
  );
  if (!answered) {
    throw new AssistantError("network", "Fewer than a majority of the merchant's relays answered");
  }
  const found = new Map<string, { event: NostrEvent; link: KnownLink }>();
  for (const events of answers.values()) {
    for (const event of events) {
      const author = isObject(event) && typeof event.pubkey === "string" ? event.pubkey : "";
      const seat = byAuthor.get(author);
      const d = dTagOf(event);
      if (!seat || d === null) continue;
      const opened = openRecord(event, {
        type: LINK_RECORD_TYPE,
        encryptionKey: hexToBytes(seat.encryptionKey),
        address: d,
        author,
        parse: (value): KnownLink | null => {
          if (!isObject(value)) return null;
          if (typeof value.version === "number" && value.version > 1) {
            throw new NewerRecordError();
          }
          const linkRelays = parseRelayList(value.relays);
          if (
            value.version !== 1 ||
            typeof value.link !== "string" ||
            !HEX_32.test(value.link) ||
            typeof value.saleKey !== "string" ||
            !HEX_32.test(value.saleKey) ||
            typeof value.createdAt !== "number" ||
            !Number.isSafeInteger(value.createdAt) ||
            value.createdAt < 0 ||
            linkRelays === null ||
            d !==
              bytesToHex(
                hmac(sha256, hexToBytes(seat.addressKey), utf8ToBytes(`link:${value.link}`))
              )
          ) {
            return null;
          }
          return {
            author: value.link,
            saleKey: value.saleKey,
            relays: linkRelays,
            createdAt: value.createdAt,
            by: seat.by,
            invoice: null
          };
        }
      });
      if (!opened) continue;
      if (opened.status === "newer") {
        throw new AssistantError("newer", "A link's record is of a newer format");
      }
      const known = found.get(opened.value.author);
      if (!known || replaces(opened.event, known.event)) {
        found.set(opened.value.author, { event: opened.event, link: opened.value });
      }
    }
  }
  return [...found.values()].map(({ link }) => link);
}

/** The links of the invoices sent by `sources`, with their number and recipient. */
async function readInvoiceLinks(
  call: Call,
  relays: readonly string[],
  sources: readonly InvoiceSource[],
  auth: Signer
): Promise<KnownLink[]> {
  const links: KnownLink[] = [];
  for (const { by, reader } of sources) {
    const read = await readInvoicesOf(
      call,
      {
        author: reader.author,
        encryptionKey: hexToBytes(reader.encryptionKey),
        addressKey: hexToBytes(reader.addressKey)
      },
      relays,
      auth.secretKey
    );
    if (!read.complete) {
      throw new AssistantError(
        "network",
        "Fewer than a majority of the merchant's relays answered"
      );
    }
    if (read.newer) throw new AssistantError("newer", "An invoice is of a newer format");
    for (const invoice of read.invoices) {
      links.push({
        author: invoice.sent.link.id,
        saleKey: invoice.sent.link.key,
        relays: invoice.sent.link.relays,
        createdAt: invoice.sent.at,
        by,
        invoice: {
          number: formatInvoiceNumber(invoice.number),
          recipient: invoice.recipient.name
        }
      });
    }
  }
  return links;
}

/** Runs `run` on each of `items`, PARALLEL_LINKS at a time, in order. */
async function eachLimited<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_LINKS, items.length) }, worker));
  return results;
}

export type LinkOptions = {
  relays: readonly string[];
  seats: readonly LinkSeat[];
  invoices: readonly InvoiceSource[];
  auth: Signer;
  bitcoinNode: BitcoinNode | null;
  range: { start: number; end: number };
};

export type LinkLines = {
  lines: Line[];
  setAside: SetAside[];
  /** The registry identities of every link's sale: a sale of a point of sale shared as a link is
   * the link's line, never the point of sale's (the app's ownerActivity). */
  sales: Set<string>;
};

type Outcome = { line: Line | null; aside: SetAside | null };

/**
 * The lines of the payment links' sales paid within `range`, those set aside, and the sales of
 * every link known. Throws `network` when what is needed could not be read, `newer` for a record
 * of a newer format.
 */
export async function readLinkLines(call: Call, options: LinkOptions): Promise<LinkLines> {
  const { relays, range, auth } = options;
  const now = call.now();
  const window = {
    start: Math.max(0, range.start - MAX_SALE_SECONDS - SALE_SPAN_SECONDS),
    end: range.end
  };
  const [recorded, invoiced] = await Promise.all([
    readLinkRecords(call, relays, options.seats, auth, window),
    readInvoiceLinks(call, relays, options.invoices, auth)
  ]);
  // Each link once: an invoice's (its number, its recipient) with « Par » of whoever made it.
  const links = new Map<string, KnownLink>();
  for (const link of recorded) links.set(link.author, link);
  for (const link of invoiced) {
    const known = links.get(link.author);
    links.set(link.author, known ? { ...known, invoice: link.invoice } : link);
  }
  const sales = new Set([...links.values()].map(({ saleKey }) => identityOf(saleKey)));
  const candidates = [...links.values()].filter(
    ({ createdAt }) => createdAt >= window.start && createdAt <= range.end
  );
  const inRange = (at: number) => at >= range.start && at <= range.end;

  const outcomes = await eachLimited(candidates, async (link): Promise<Outcome> => {
    const saleKey = hexToBytes(link.saleKey);
    // The sale's records are read with a key of this read alone.
    const authKey = secureRandomBytes(32);
    const read = await readLink(call.pool, link.relays, link.author, saleKey, authKey, {
      pointOfSale: true
    });
    if (!read.ok) {
      if (read.reason === "relays") {
        throw new AssistantError("network", "Fewer than a majority of a link's relays answered");
      }
      // Never published (nothing could pay it), or not readable here.
      return { line: null, aside: null };
    }
    const { sale, final } = read;
    const base = {
      id: `link:${link.author}`,
      source: "link" as const,
      note: sale.note,
      invoice: link.invoice,
      by: link.by,
      rate: null,
      imported: false
    };
    const aside = (reason: SetAside["reason"], at: number): Outcome => ({
      line: null,
      aside: inRange(at)
        ? {
            sale: identityOf(link.saleKey),
            at,
            note: sale.note,
            fiat: sale.fiat,
            by: link.by,
            reason
          }
        : null
    });
    let payments: LinePayment[];
    let fiat = sale.fiat;
    let acceptance: Line["acceptance"] = null;
    if (final) {
      if (final.status === "expired" || final.status === "canceled") {
        return { line: null, aside: null };
      }
      payments = [
        ...final.lightning.map((paid) =>
          lightningPayment(paid.paymentHash, paid.sats, paid.timestamp)
        ),
        ...(final.onchain?.transactions ?? []).map((tx) =>
          onchainPayment(tx.txid, tx.sats, Math.floor(tx.receivedAt / 1000))
        )
      ];
      if (final.status === "underpaid") {
        // A line once the merchant accepted it, at what it received (the app's applyAcceptances).
        const accepted = await readAcceptance(call.pool, link.relays, sale.owner, saleKey, authKey);
        if (accepted === undefined) {
          throw new AssistantError("network", "Fewer than a majority of a link's relays answered");
        }
        if (accepted === null || final.received < accepted.received) {
          return { line: null, aside: null };
        }
        acceptance = {
          received: accepted.received.toString(),
          due: accepted.due.toString(),
          at: accepted.at,
          fiat: sale.fiat
        };
        fiat = {
          ...sale.fiat,
          minor: receivedMinor(sale.fiat.minor, accepted.due, final.received)
        };
      }
    } else {
      // Nothing of its sale could be paid in the period.
      if (sale.startsAt - SALE_SPAN_SECONDS > range.end) return { line: null, aside: null };
      if (sale.endsAt + SALE_SPAN_SECONDS < range.start) return { line: null, aside: null };
      const [lightning, onchain] = await Promise.all([
        readLightning(call.pool, call.http, linkSale(saleKey, sale, ""), link.relays, sale, now),
        sale.onchainAddress === null
          ? Promise.resolve({ ok: true as const, payments: [] })
          : readOnchain(sale.onchainAddress, options.bitcoinNode, call.http, () => now * 1000)
      ]);
      if (!lightning.ok) {
        // Made under a former name of the business: the merchant's app tells it (its final).
        if (lightning.reason === "former_name")
          return aside("unproven", Math.min(now, sale.endsAt));
        throw new AssistantError("network", "A link's payments could not be read");
      }
      if (!onchain.ok)
        throw new AssistantError("network", "The explorer could not tell a link's payments");
      const deep = onchain.payments.filter(({ confirmations }) => confirmations >= CONFIRMATIONS);
      if (deep.length < onchain.payments.length) {
        return aside(
          "confirming",
          Math.floor(Math.max(...onchain.payments.map(({ at }) => at)) / 1000)
        );
      }
      payments = [
        ...lightning.payments.map((paid) =>
          lightningPayment(paid.paymentHash, paid.sats, paid.timestamp)
        ),
        ...deep.map((tx) => onchainPayment(tx.txid, tx.sats, Math.floor(tx.at / 1000)))
      ];
    }
    payments.sort((a, b) => b.timestamp - a.timestamp || (a.id < b.id ? -1 : 1));
    const received = payments.reduce((total, p) => total + BigInt(p.amountSats), 0n);
    if (received === 0n) return { line: null, aside: null };
    const at = payments[0]!.timestamp;
    if (!inRange(at)) return { line: null, aside: null };
    return {
      line: { ...base, at, payments, sats: received.toString(), fiat, acceptance },
      aside: null
    };
  });

  const lines = outcomes.flatMap(({ line }) => (line ? [line] : []));
  const setAside = outcomes.flatMap(({ aside }) => (aside ? [aside] : []));
  return {
    lines: lines.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    setAside: setAside.sort(
      (a, b) => a.at - b.at || (a.sale < b.sale ? -1 : a.sale > b.sale ? 1 : 0)
    ),
    sales
  };
}

function lightningPayment(paymentHash: string, sats: bigint, timestamp: number): LinePayment {
  return {
    id: paymentHash,
    direction: "receive",
    status: "completed",
    amountSats: sats.toString(),
    feeSats: "0",
    timestamp,
    network: "lightning",
    paymentHash,
    txId: null,
    lightningAddress: null,
    description: null
  };
}

function onchainPayment(txid: string, sats: bigint, timestamp: number): LinePayment {
  return {
    id: txid,
    direction: "receive",
    status: "completed",
    amountSats: sats.toString(),
    feeSats: "0",
    timestamp,
    network: "bitcoin",
    paymentHash: null,
    txId: txid,
    lightningAddress: null,
    description: null
  };
}
