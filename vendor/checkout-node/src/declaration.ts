import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { outerKey, registryAddress, type Registry, type Sale } from "./derive.js";
import { readJson } from "./json.js";
import { decodeBolt11, type Bolt11 } from "./lightning/bolt11.js";
import type { NostrEvent } from "./nostr/event.js";
import { nip44Decrypt, nip44Encrypt } from "./nostr/nip44.js";
import { NewerRecordError, openRecord, sealRecord } from "./nostr/record.js";
import { isDepositAddress } from "./onchain/address.js";
import { DECLARATION_RECORD_TYPE, DECLARATION_VERSION, MAX_DECLARED_DIGITS } from "./protocol.js";
import type { RandomBytes } from "./random.js";
import { isHex32, isObject } from "./text.js";
import { parseHttpsUrl } from "./urls.js";

/*
 * The declaration of an invoice in the merchant's registry of payments (SPEC.md, "The
 * declaration"), as the merchant's app reads it: published on a majority of the
 * merchant's relays before the invoice is shown, so that its payment counts for this order's sale
 * and for no other. Its format is the app's, version 1: changing it needs a new version there first,
 * but for an optional field the app ignores (as `taker`): `rest`, in a rest invoice's.
 */

/**
 * The price a sale is declared with, as the declaration's JSON holds it: `minor` is a JSON number
 * (at most 2^53 − 1). For a sale in sats: `{ minor: <sats>, digits: 0, currency: "SAT" }`.
 */
export type DeclaredPrice = { minor: number; digits: number; currency: string };

export type DeclarationInput = {
  sale: Sale;
  /** The invoice, checked (checkInvoice). */
  invoice: string;
  verifyUrl: string;
  paymentHash: string;
  price: DeclaredPrice;
  /** What the merchant's app shows: the note, else the reference. */
  note: string;
  /** Unix seconds. */
  createdAt: number;
  /**
   * The invoice whose rest this invoice is (SPEC.md, "The rest of an underpayment"): its deposit
   * address and its end; absent for an invoice of the order.
   */
  rest?: RestOf | undefined;
  random?: RandomBytes | undefined;
};

/**
 * The signed declaration of an invoice for `sale`: the declaration (inside, NIP-44 with the ECDH
 * conversation key of the sale's secret and the merchant's reading key), then
 * `{"t": "registry-declaration", "v": {"sealed": …}}` padded to a multiple of 256 bytes (outside,
 * NIP-44 with outerKey), kind 30078, `d` = registryAddress, signed by the sale's secret.
 */
export function declarationEvent(input: DeclarationInput): NostrEvent {
  const { sale } = input;
  const declaration = {
    version: DECLARATION_VERSION,
    invoice: input.invoice,
    verifyUrl: input.verifyUrl,
    sale: { key: bytesToHex(sale.key), fiat: input.price, note: input.note },
    // "By" in the app: this integration.
    taker: sale.taker,
    // Only in a rest invoice's: the app ignores it, and counts the payment for the sale.
    ...(input.rest === undefined ? {} : { rest: input.rest })
  };
  const address = registryAddress(sale.registry.key, input.paymentHash);
  return sealRecord({
    type: DECLARATION_RECORD_TYPE,
    value: { sealed: nip44Encrypt(JSON.stringify(declaration), sale.innerKey, input.random) },
    signer: sale.secretKey,
    encryptionKey: outerKey(sale.registry.key, address, sale.author),
    address,
    createdAt: input.createdAt,
    ...(input.random ? { random: input.random } : {})
  });
}

/** The invoice an invoice of the rest is of: its deposit address and its end (Unix seconds). */
export type RestOf = { address: string; expiresAt: number };

/** A declaration's `rest`: absent (null), or the invoice it names; undefined when invalid. */
function restOfValue(value: unknown): RestOf | null | undefined {
  if (value === undefined) return null;
  if (!isObject(value)) return undefined;
  const { address, expiresAt } = value;
  if (!isDepositAddress(address)) return undefined;
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    return undefined;
  }
  return { address, expiresAt };
}

/** A declaration of the sale, opened by its holder. */
export type OpenedDeclaration = {
  event: NostrEvent;
  invoice: string;
  decoded: Bolt11;
  verifyUrl: string;
  price: DeclaredPrice;
  note: string;
  /** Unix seconds: the event's `created_at`. */
  declaredAt: number;
  /** The invoice whose rest it is; null for an invoice of the order. */
  rest: RestOf | null;
};

function parsePrice(value: unknown): DeclaredPrice | null {
  if (!isObject(value)) return null;
  const { minor, digits, currency } = value;
  // A safe integer is at most MAX_MINOR_UNITS (2^53 − 1).
  if (typeof minor !== "number" || !Number.isSafeInteger(minor) || minor < 0) return null;
  if (
    typeof digits !== "number" ||
    !Number.isInteger(digits) ||
    digits < 0 ||
    digits > MAX_DECLARED_DIGITS
  ) {
    return null;
  }
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  return { minor, digits, currency };
}

/**
 * What a relay sent, if it is a declaration of `sale`: author, `d` tag (the address of its own
 * invoice), outer and inner encryption, signature, and the sale's own key inside. Null otherwise;
 * throws NewerRecordError for one of a newer format.
 */
export function openDeclaration(value: unknown, sale: Sale): OpenedDeclaration | null {
  const tags = isObject(value) ? value.tags : undefined;
  const address = Array.isArray(tags)
    ? (tags as unknown[]).find((tag) => Array.isArray(tag) && tag[0] === "d")
    : undefined;
  const d: unknown = Array.isArray(address) ? address[1] : undefined;
  if (!isHex32(d)) return null;
  const opened = openRecord(value, {
    type: DECLARATION_RECORD_TYPE,
    encryptionKey: outerKey(sale.registry.key, d, sale.author),
    address: d,
    author: sale.author,
    parse: (outside, event: NostrEvent): OpenedDeclaration | null => {
      const sealed = isObject(outside) ? outside.sealed : undefined;
      if (typeof sealed !== "string") return null;
      let inside: unknown;
      try {
        inside = readJson(nip44Decrypt(sealed, sale.innerKey));
      } catch {
        return null;
      }
      if (!isObject(inside)) return null;
      const v = inside;
      if (typeof v.version === "number" && v.version > DECLARATION_VERSION) {
        throw new NewerRecordError();
      }
      if (v.version !== DECLARATION_VERSION || typeof v.invoice !== "string") return null;
      if (typeof v.verifyUrl !== "string" || !parseHttpsUrl(v.verifyUrl)) return null;
      const saleValue = v.sale;
      if (!isObject(saleValue)) return null;
      if (saleValue.key !== bytesToHex(sale.key) || typeof saleValue.note !== "string") {
        return null;
      }
      const price = parsePrice(saleValue.fiat);
      if (!price) return null;
      const rest = restOfValue(v.rest);
      if (rest === undefined) return null;
      const decoded = decodeBolt11(v.invoice);
      if (!decoded || decoded.network !== "bc" || decoded.amountMsat === null) return null;
      if (decoded.amountMsat <= 0n || decoded.amountMsat % 1000n !== 0n) return null;
      if (d !== registryAddress(sale.registry.key, decoded.paymentHash)) return null;
      return {
        event,
        invoice: v.invoice,
        decoded,
        verifyUrl: v.verifyUrl,
        price,
        note: saleValue.note,
        declaredAt: event.created_at,
        rest
      };
    }
  });
  if (opened?.status === "newer") throw new NewerRecordError();
  return opened?.status === "ok" ? opened.value : null;
}

/** The registry of a channel's hex fields. */
export function registryOf(registryKey: string, registryReader: string): Registry {
  return { key: hexToBytes(registryKey), reader: registryReader };
}
