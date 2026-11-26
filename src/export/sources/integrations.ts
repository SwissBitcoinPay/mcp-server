import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { outerKey, registryAddress } from "../../../vendor/checkout-node/src/derive.js";
import { getJson } from "../../../vendor/checkout-node/src/http.js";
import { readJson } from "../../../vendor/checkout-node/src/json.js";
import { decodeBolt11, type Bolt11 } from "../../../vendor/checkout-node/src/lightning/bolt11.js";
import { fetchPayRequest } from "../../../vendor/checkout-node/src/lnurl.js";
import type { NostrEvent } from "../../../vendor/checkout-node/src/nostr/event.js";
import { conversationKey, nip44Decrypt } from "../../../vendor/checkout-node/src/nostr/nip44.js";
import {
  NewerRecordError,
  dTagOf,
  openRecord,
  recordsThatOpen,
  replaces
} from "../../../vendor/checkout-node/src/nostr/record.js";
import { openWitness } from "../../../vendor/checkout-node/src/onchain/witness.js";
import {
  DECLARATION_RECORD_TYPE,
  RECORD_KIND
} from "../../../vendor/checkout-node/src/protocol.js";
import { parseHttpsUrl, sameHost, type HttpsUrl } from "../../../vendor/checkout-node/src/urls.js";

import type { Call } from "../../protocol/context.js";
import { AssistantError } from "../../protocol/errors.js";
import type { Signer } from "../../protocol/keys.js";
import { isObject } from "../../protocol/text.js";
import type { GrantSeat } from "../grant.js";
import type { Line, LineFiat, LinePayment } from "../lines.js";

import { identityOf, type SetAside } from "./till.js";

/*
 * The sales of the integrations (SPEC.md §20, The integrations' sales), from what their servers
 * publish (checkout-spec SPEC.md §31, Witnesses; §32, Lightning witnesses): each Lightning invoice
 * an integration saw paid, dated when it saw it, counted as the merchant's app counts a Lightning
 * payment — its declaration in the registry, by its sale alone, and the merchant's Lightning
 * address telling at its verify URL that it was paid. An order paid on-chain (a transaction its
 * server saw paying its lease's address, or the Lightning rest of such an order) is set aside: the
 * merchant's app tells it.
 */

const LIGHTNING_WITNESS_TYPE = "integration-lightning-paid";
/** The clock tolerance and the grace period a witness's date may lie within (§32). */
const CLOCK_TOLERANCE_SECONDS = 300;
const GRACE_SECONDS = 120;
/** The currency of an integration's sale asked in sats: valued as a transfer (the app's). */
const SATS_CURRENCY = "SAT";
const ADDRESSES_PER_READ = 100;
const HEX_32 = /^[0-9a-f]{64}$/;

/** An integration of the team, with the keys of what its server publishes (the grant's). */
export type IntegrationSeat = {
  name: string;
  /** The channel's encryption key: the witnesses' NIP-44 key (hex). */
  channelKey: string;
  paid: { author: string; addressKey: string };
  seen: { author: string; addressKey: string };
  removedAt: number | null;
};

export function integrationSeatsOf(seats: readonly GrantSeat[]): IntegrationSeat[] {
  return seats.flatMap((seat): IntegrationSeat[] =>
    seat.role === "integration"
      ? [
          {
            name: seat.name,
            channelKey: seat.channelKey,
            paid: seat.paid,
            seen: seat.seen,
            removedAt: seat.removedAt
          }
        ]
      : []
  );
}

/** A Lightning witness, opened (§32). */
export type LightningWitness = {
  invoice: string;
  paymentHash: string;
  /** Sats, a decimal string. */
  sats: string;
  verifyUrl: string;
  preimage: string;
  /** Unix seconds: when the integration saw it paid (the event's created_at). */
  paidAt: number;
};

/**
 * What a relay sent, if it is a Lightning witness of the integration whose paid author, paid
 * address key and channel key are `keys` (checkout-spec SPEC.md §32, Opening one); null otherwise.
 */
export function openLightningWitness(
  value: unknown,
  keys: { author: string; addressKey: Uint8Array; encryptionKey: Uint8Array }
):
  | { status: "ok"; event: NostrEvent; value: LightningWitness }
  | { status: "newer"; event: NostrEvent }
  | null {
  const d = dTagOf(value);
  if (d === null) return null;
  return openRecord(value, {
    type: LIGHTNING_WITNESS_TYPE,
    encryptionKey: keys.encryptionKey,
    address: d,
    author: keys.author,
    parse: (v, event): LightningWitness | null => {
      if (!isObject(v)) return null;
      if (typeof v.version === "number" && v.version > 1) throw new NewerRecordError();
      if (v.version !== 1 || typeof v.invoice !== "string") return null;
      if (typeof v.verifyUrl !== "string" || !parseHttpsUrl(v.verifyUrl)) return null;
      if (typeof v.preimage !== "string" || !HEX_32.test(v.preimage)) return null;
      const decoded = decodeBolt11(v.invoice);
      if (
        !decoded ||
        decoded.network !== "bc" ||
        decoded.amountMsat === null ||
        decoded.amountMsat <= 0n ||
        decoded.amountMsat % 1000n !== 0n ||
        bytesToHex(sha256(hexToBytes(v.preimage))) !== decoded.paymentHash ||
        d !== bytesToHex(hmac(sha256, keys.addressKey, hexToBytes(decoded.paymentHash))) ||
        event.created_at < decoded.timestamp - CLOCK_TOLERANCE_SECONDS ||
        event.created_at > decoded.timestamp + decoded.expirySeconds + GRACE_SECONDS
      ) {
        return null;
      }
      return {
        invoice: v.invoice,
        paymentHash: decoded.paymentHash,
        sats: (decoded.amountMsat / 1000n).toString(),
        verifyUrl: v.verifyUrl,
        preimage: v.preimage,
        paidAt: event.created_at
      };
    }
  });
}

/** A declaration, opened with the merchant's reading key (what the owner's app reads). */
type ReadDeclaration = {
  /** Hex: the sale's registry identity, the declaration's author. */
  sale: string;
  decoded: Bolt11;
  verifyUrl: string;
  price: LineFiat;
  note: string;
  /** Whether it is the invoice of the rest of an on-chain underpayment (§31). */
  rest: boolean;
};

/** `value`, if it is a declaration at `d` (by any author), opened with `readerSecret`. */
function openDeclarationAsReader(
  value: unknown,
  registryKey: Uint8Array,
  readerSecret: Uint8Array
): { author: string; declaration: ReadDeclaration | null } | null {
  const d = dTagOf(value);
  const author = isObject(value) && typeof value.pubkey === "string" ? value.pubkey : null;
  if (d === null || author === null) return null;
  let readable: ReadDeclaration | null = null;
  const opened = openRecord(value, {
    type: DECLARATION_RECORD_TYPE,
    encryptionKey: outerKey(registryKey, d, author),
    address: d,
    author,
    parse: (outside) => {
      const sealed = isObject(outside) ? outside.sealed : undefined;
      if (typeof sealed !== "string") return null;
      // A declaration whose inside does not open is still a declaration of its author's.
      readable = insideOf(sealed, d, author, registryKey, readerSecret);
      return true;
    }
  });
  if (!opened) return null;
  return { author, declaration: opened.status === "ok" ? readable : null };
}

function insideOf(
  sealed: string,
  d: string,
  author: string,
  registryKey: Uint8Array,
  readerSecret: Uint8Array
): ReadDeclaration | null {
  let v: unknown;
  try {
    v = readJson(nip44Decrypt(sealed, conversationKey(readerSecret, author)));
  } catch {
    return null;
  }
  if (!isObject(v) || v.version !== 1 || typeof v.invoice !== "string") return null;
  if (typeof v.verifyUrl !== "string" || !parseHttpsUrl(v.verifyUrl)) return null;
  const sale = v.sale;
  if (!isObject(sale) || typeof sale.key !== "string" || !HEX_32.test(sale.key)) return null;
  if (identityOf(sale.key) !== author || typeof sale.note !== "string") return null;
  const fiat = sale.fiat;
  if (
    !isObject(fiat) ||
    typeof fiat.minor !== "number" ||
    !Number.isSafeInteger(fiat.minor) ||
    fiat.minor < 0 ||
    typeof fiat.digits !== "number" ||
    !Number.isInteger(fiat.digits) ||
    fiat.digits < 0 ||
    fiat.digits > 8 ||
    typeof fiat.currency !== "string" ||
    !/^[A-Z]{3}$/.test(fiat.currency)
  ) {
    return null;
  }
  const decoded = decodeBolt11(v.invoice);
  if (!decoded || d !== registryAddress(registryKey, decoded.paymentHash)) return null;
  return {
    sale: author,
    decoded,
    verifyUrl: v.verifyUrl,
    price: { minor: fiat.minor, digits: fiat.digits, currency: fiat.currency },
    note: sale.note,
    rest: v.rest !== undefined
  };
}

/** The declarations of each of `hashes`, read whole on a majority: by author, opened or not. */
async function declarationsOf(
  call: Call,
  relays: readonly string[],
  registryKey: Uint8Array,
  readerSecret: Uint8Array,
  hashes: readonly string[],
  auth: Signer
): Promise<Map<string, Map<string, ReadDeclaration | null>>> {
  const found = new Map(hashes.map((hash) => [hash, new Map<string, ReadDeclaration | null>()]));
  const hashOf = new Map(hashes.map((hash) => [registryAddress(registryKey, hash), hash]));
  const addresses = [...hashOf.keys()];
  for (let first = 0; first < addresses.length; first += ADDRESSES_PER_READ) {
    const { answers, answered } = await call.pool.queryRelays(
      relays,
      { kinds: [RECORD_KIND], "#d": addresses.slice(first, first + ADDRESSES_PER_READ) },
      auth.secretKey,
      {
        paged: true,
        keep: recordsThatOpen((d, author) =>
          d !== null && hashOf.has(d) ? outerKey(registryKey, d, author) : null
        )
      }
    );
    if (!answered) {
      throw new AssistantError(
        "network",
        "Fewer than a majority of the merchant's relays answered"
      );
    }
    for (const events of answers.values()) {
      for (const event of events) {
        const hash = hashOf.get(dTagOf(event) ?? "");
        if (hash === undefined) continue;
        const opened = openDeclarationAsReader(event, registryKey, readerSecret);
        if (!opened) continue;
        const known = found.get(hash)!;
        if (!known.get(opened.author)) known.set(opened.author, opened.declaration);
      }
    }
  }
  return found;
}

/** Whether the merchant's Lightning address tells at `verifyUrl` that `paymentHash` was paid. */
async function paidAtService(call: Call, verifyUrl: string, paymentHash: string) {
  try {
    const { ok, body } = await getJson(verifyUrl, call.http);
    if (!ok || !isObject(body) || body.settled !== true) return false;
    const { pr, preimage } = body;
    if (typeof pr !== "string" || typeof preimage !== "string") return false;
    const decoded = decodeBolt11(pr);
    return (
      decoded !== null &&
      decoded.paymentHash === paymentHash &&
      bytesToHex(sha256(hexToBytes(preimage.toLowerCase()))) === paymentHash
    );
  } catch {
    return false;
  }
}

export type IntegrationOptions = {
  relays: readonly string[];
  seats: readonly IntegrationSeat[];
  auth: Signer;
  registryKey: string;
  /** The secret half of the registry's reading key (the grant's). */
  registryReader: string;
  /** The merchant's Lightning address (the channel's): verify URLs are its own. */
  lightningAddress: string;
  range: { start: number; end: number };
};

/**
 * The lines of the integrations' sales paid over Lightning within `range`, and those set aside.
 * Throws `network` when what is needed could not be read, `newer` for a witness of a newer format.
 */
export async function readIntegrationLines(
  call: Call,
  options: IntegrationOptions
): Promise<{ lines: Line[]; setAside: SetAside[] }> {
  const { relays, seats, auth, range } = options;
  if (seats.length === 0) return { lines: [], setAside: [] };
  const byPaid = new Map(seats.map((seat) => [seat.paid.author, seat]));
  const bySeen = new Map(seats.map((seat) => [seat.seen.author, seat]));
  const keyOf = (author: string) => {
    const seat = byPaid.get(author) ?? bySeen.get(author);
    return seat ? hexToBytes(seat.channelKey) : null;
  };
  const { answers, answered } = await call.pool.queryRelays(
    relays,
    {
      kinds: [RECORD_KIND],
      authors: [...byPaid.keys(), ...bySeen.keys()],
      since: range.start,
      until: range.end
    },
    auth.secretKey,
    { paged: true, keep: recordsThatOpen((_, author) => keyOf(author)) }
  );
  if (!answered) {
    throw new AssistantError("network", "Fewer than a majority of the merchant's relays answered");
  }
  const paid = new Map<
    string,
    { event: NostrEvent; witness: LightningWitness; seat: IntegrationSeat }
  >();
  // The sales an integration's server saw paid on-chain, and when (the latest it saw).
  const onchain = new Map<string, { at: number; sats: bigint; seat: IntegrationSeat }>();
  for (const events of answers.values()) {
    for (const event of events) {
      const author = isObject(event) && typeof event.pubkey === "string" ? event.pubkey : "";
      const paidBy = byPaid.get(author);
      if (paidBy) {
        const opened = openLightningWitness(event, {
          author,
          addressKey: hexToBytes(paidBy.paid.addressKey),
          encryptionKey: hexToBytes(paidBy.channelKey)
        });
        if (!opened) continue;
        if (opened.status === "newer") {
          throw new AssistantError("newer", "An integration's witness is of a newer format");
        }
        // A removed integration vouches for what it saw before only.
        if (paidBy.removedAt !== null && opened.value.paidAt > paidBy.removedAt) continue;
        const known = paid.get(opened.value.paymentHash);
        if (!known || replaces(opened.event, known.event)) {
          paid.set(opened.value.paymentHash, {
            event: opened.event,
            witness: opened.value,
            seat: paidBy
          });
        }
        continue;
      }
      const seenBy = bySeen.get(author);
      if (!seenBy) continue;
      const opened = openWitness(event, {
        // Opening reads only: it never signs.
        secretKey: new Uint8Array(32),
        author,
        addressKey: hexToBytes(seenBy.seen.addressKey),
        encryptionKey: hexToBytes(seenBy.channelKey)
      });
      if (!opened) continue;
      if (opened.status === "newer") {
        throw new AssistantError("newer", "An integration's witness is of a newer format");
      }
      const { witness } = opened;
      const at = opened.event.created_at;
      if (witness.sale === null) continue;
      if (seenBy.removedAt !== null && at > seenBy.removedAt) continue;
      const known = onchain.get(witness.sale);
      onchain.set(witness.sale, {
        at: Math.max(known?.at ?? 0, at),
        sats: (known?.sats ?? 0n) + witness.sats,
        seat: seenBy
      });
    }
  }

  const registryKey = hexToBytes(options.registryKey);
  const declared = await declarationsOf(
    call,
    relays,
    registryKey,
    hexToBytes(options.registryReader),
    [...paid.keys()],
    auth
  );
  // Verify URLs are the merchant's Lightning address's (its callback's host).
  let callback: HttpsUrl | null = null;
  if (paid.size > 0) {
    try {
      callback = parseHttpsUrl(
        (await fetchPayRequest(options.lightningAddress, call.http)).callback
      );
    } catch {
      throw new AssistantError("network", "The merchant's Lightning address could not be read");
    }
  }

  const setAside: SetAside[] = [];
  type Sale = {
    seat: IntegrationSeat;
    declaration: ReadDeclaration;
    payments: LinePayment[];
    unproven: boolean;
    /** When its integration last saw one of its invoices paid. */
    seenAt: number;
  };
  const sales = new Map<string, Sale>();
  const asideOf = (
    sale: string,
    at: number,
    seat: IntegrationSeat,
    reason: SetAside["reason"],
    declaration: ReadDeclaration | null
  ) => {
    setAside.push({
      sale,
      at,
      note: declaration?.note ?? "",
      fiat: declaration && declaration.price.currency !== SATS_CURRENCY ? declaration.price : null,
      by: { kind: "seat", name: seat.name },
      reason
    });
  };
  for (const [hash, { witness, seat }] of paid) {
    const authors = declared.get(hash)!;
    if (authors.size !== 1) {
      // Declared by no sale, or by two: the merchant settles it.
      asideOf(hash, witness.paidAt, seat, authors.size === 0 ? "unproven" : "conflict", null);
      continue;
    }
    const [author, declaration] = [...authors][0]!;
    if (!declaration) {
      asideOf(author, witness.paidAt, seat, "unproven", null);
      continue;
    }
    if (declaration.rest || onchain.has(author)) {
      // Of an order paid on-chain too: the merchant's app tells it.
      onchain.delete(author);
      asideOf(author, witness.paidAt, seat, "onchain", declaration);
      continue;
    }
    const sale: Sale = sales.get(author) ?? {
      seat,
      declaration,
      payments: [],
      unproven: false,
      seenAt: 0
    };
    sale.seenAt = Math.max(sale.seenAt, witness.paidAt);
    sales.set(author, sale);
    const verifyUrl = parseHttpsUrl(declaration.verifyUrl);
    const ownHost = callback !== null && verifyUrl !== null && sameHost(verifyUrl, callback);
    if (!ownHost || !(await paidAtService(call, declaration.verifyUrl, hash))) {
      sale.unproven = true;
      continue;
    }
    sale.payments.push({
      id: hash,
      direction: "receive",
      status: "completed",
      amountSats: witness.sats,
      feeSats: "0",
      timestamp: witness.paidAt,
      network: "lightning",
      paymentHash: hash,
      txId: null,
      lightningAddress: null,
      description: null
    });
  }
  for (const [sale, seen] of onchain) {
    asideOf(sale, seen.at, seen.seat, "onchain", null);
  }

  const lines: Line[] = [];
  for (const [author, sale] of sales) {
    if (sale.unproven || sale.payments.length === 0) {
      asideOf(author, sale.seenAt, sale.seat, "unproven", sale.declaration);
      continue;
    }
    const at = Math.max(...sale.payments.map(({ timestamp }) => timestamp));
    sale.payments.sort((a, b) => b.timestamp - a.timestamp || (a.id < b.id ? -1 : 1));
    const { price, note } = sale.declaration;
    lines.push({
      id: `sale:${author}`,
      source: "integration",
      at,
      note,
      invoice: null,
      by: { kind: "seat", name: sale.seat.name },
      payments: sale.payments,
      sats: sale.payments.reduce((total, p) => total + BigInt(p.amountSats), 0n).toString(),
      // In sats alone: its sats valued as a transfer's (the app's ownerActivity).
      fiat: price.currency === SATS_CURRENCY ? null : price,
      rate: null,
      imported: false,
      acceptance: null
    });
  }
  return {
    lines: lines.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)),
    setAside: setAside.sort((a, b) => a.at - b.at || (a.sale < b.sale ? -1 : 1))
  };
}
