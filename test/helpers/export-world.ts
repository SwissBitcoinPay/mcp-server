import { schnorr } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { declarationEvent } from "../../vendor/checkout-node/src/declaration.js";
import { sealRecord } from "../../vendor/checkout-node/src/nostr/record.js";

import { decisionAddress, partAddress } from "../../src/export/grant.js";
import { linkSale } from "../../src/protocol/link.js";

import { bytes, type World } from "./world.js";

/*
 * What the export's tests set up on the test merchant's relays: the merchant's grant of the export
 * to the assistant (as the app writes it), and a sale of the owner's point of sale paid over
 * Lightning at PAID_AT (its record with its proof, its declaration).
 */

const DEVICE_SECRET = bytes(90);
const RECORDS_KEY = bytes(91);
const RECORDS_ADDRESS_KEY = bytes(92);
const readKeys = (seed: number) => ({
  author: bytesToHex(schnorr.getPublicKey(bytes(seed))),
  encryptionKey: bytesToHex(bytes(seed + 1)),
  addressKey: bytesToHex(bytes(seed + 2))
});
/** 03.11.2026 08:00 UTC, 09:00 in Zurich. */
export const PAID_AT = 1_793_692_800;
export const FIAT = { minor: 1_250, digits: 2, currency: "CHF" };

/** The merchant allows (or withdraws) the export in the app: its decision, then its keys. */
export function grantExport(world: World, allowed = true, at = world.now - 3600) {
  const { encryptionKey } = world.keys.exportGrant;
  const seal = (type: string, value: unknown, address: string) =>
    world.store(
      sealRecord({ type, value, signer: world.teamSecret, encryptionKey, address, createdAt: at })
    );
  seal("assistant-export", { version: 1, allowed, updatedAt: at }, decisionAddress(world.keys));
  seal(
    "assistant-export-keys",
    {
      version: 1,
      grantedAt: at,
      part: 0,
      parts: 1,
      account: {
        registryReader: bytesToHex(world.readerSecret),
        invoices: readKeys(100),
        paymentRates: readKeys(110),
        walletSends: readKeys(120),
        archive: readKeys(130),
        legacyHistory: readKeys(140)
      },
      format: { language: "fr", locale: "fr-CH", timeZone: "Europe/Zurich" },
      omitted: 0,
      seats: [
        {
          role: "owner",
          id: "4".repeat(32),
          name: null,
          since: world.now - 86_400 * 30,
          removedAt: null,
          records: {
            sales: bytesToHex(schnorr.getPublicKey(DEVICE_SECRET)),
            links: readKeys(150).author,
            encryptionKey: bytesToHex(RECORDS_KEY),
            addressKey: bytesToHex(RECORDS_ADDRESS_KEY)
          }
        }
      ]
    },
    partAddress(world.keys, 0)
  );
}

/** A sale of the owner's point of sale, paid over Lightning at PAID_AT. */
export function paidTillSale(world: World) {
  const sale = linkSale(
    bytes(95),
    { registryKey: bytesToHex(world.registryKey), registryReader: world.reader },
    "0".repeat(64)
  );
  const invoice = world.breezInvoice(15_625n, PAID_AT - 60, 600);
  world.store(
    declarationEvent({
      sale,
      invoice: invoice.pr,
      verifyUrl: invoice.verify,
      paymentHash: invoice.paymentHash,
      price: FIAT,
      note: "Café",
      createdAt: invoice.timestamp
    })
  );
  world.store(
    sealRecord({
      type: "team-sale",
      value: {
        version: 1,
        sats: "15625",
        fiat: FIAT,
        note: "Café",
        createdAt: invoice.timestamp,
        expiresAt: invoice.timestamp + 600,
        paidAt: PAID_AT,
        onchainTag: null,
        sale: sale.author,
        saleKey: bytesToHex(bytes(95)),
        paymentHash: invoice.paymentHash,
        verifyUrl: invoice.verify,
        onchainAddress: null,
        lightning: [{ invoice: invoice.pr, preimage: invoice.preimage }]
      },
      signer: DEVICE_SECRET,
      encryptionKey: RECORDS_KEY,
      address: bytesToHex(
        hmac(sha256, RECORDS_ADDRESS_KEY, utf8ToBytes(`sale:${invoice.paymentHash}`))
      ),
      createdAt: PAID_AT
    })
  );
}
