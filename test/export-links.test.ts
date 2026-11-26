import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { declarationEvent } from "../vendor/checkout-node/src/declaration.js";
import { openRecord, sealRecord } from "../vendor/checkout-node/src/nostr/record.js";
import { depositAddress, payment, txid } from "../vendor/checkout-node/test/helpers/chain.js";

import { readLinkLines, type InvoiceSource, type LinkSeat } from "../src/export/sources/links.js";
import { identityOf } from "../src/export/sources/till.js";
import { withCall } from "../src/protocol/context.js";
import { acceptanceKeys } from "../src/protocol/follow/sale.js";
import {
  linkAddress,
  linkSale,
  ownerFinalAddress,
  parseLinkPayload
} from "../src/protocol/link.js";
import { makeInvoice, type MadeInvoice } from "../src/protocol/make.js";
import { pointHour } from "../src/protocol/points.js";

import { LIGHTNING_ADDRESS, World, bytes } from "./helpers/world.js";

/*
 * The sales of the payment links (SPEC.md §20): an assistant's invoice (its link of version 4, its
 * record, the invoice), a link a point of sale shared (version 3, an employee's record), each told
 * by its final version when the merchant's app wrote one, else by its proven payments.
 */

let world: World;
const PRICE = 80_000;

beforeEach(async () => {
  world = await new World().start();
  world.publishChannel(world.channelValue(world.now - 100), world.now - 100);
  world.publishLot(
    Array.from({ length: 20 }, (_, n) => depositAddress(`lot ${n}`)),
    world.now - 90
  );
  world.setPoints(
    "CHF",
    pointHour(world.now) - 48 * 3600,
    pointHour(world.now) + 60 * 86_400,
    PRICE
  );
});

afterEach(async () => {
  await world.stop();
});

/** The test's day, around its clock. */
const day = () => ({ start: world.now - 43_200, end: world.now + 43_199 });

const assistantSeat = (): LinkSeat => ({
  by: { kind: "seat", name: "Claude" },
  author: world.keys.member.links.publicKey,
  encryptionKey: bytesToHex(world.keys.member.records.encryptionKey),
  addressKey: bytesToHex(world.keys.member.records.addressKey)
});

const assistantInvoices = (): InvoiceSource => ({
  by: { kind: "seat", name: "Claude" },
  reader: {
    author: world.keys.invoices.nostr.publicKey,
    encryptionKey: bytesToHex(world.keys.invoices.encryptionKey),
    addressKey: bytesToHex(world.keys.invoices.addressKey)
  }
});

const EMPLOYEE_SECRET = bytes(60);
const employee: LinkSeat = {
  by: { kind: "seat", name: "Julie" },
  author: bytesToHex(schnorr.getPublicKey(EMPLOYEE_SECRET)),
  encryptionKey: bytesToHex(bytes(61)),
  addressKey: bytesToHex(bytes(62))
};

function read(
  range = day(),
  seats: LinkSeat[] = [assistantSeat(), employee],
  invoices: InvoiceSource[] = [assistantInvoices()]
) {
  return withCall(world.services(), (call) =>
    readLinkLines(call, {
      relays: world.relays,
      seats,
      invoices,
      auth: world.keys.member.nostr,
      bitcoinNode: null,
      range
    })
  );
}

async function make(): Promise<MadeInvoice> {
  return withCall(world.services(), (call) =>
    makeInvoice(call, world.access, world.keys, {
      recipient: {
        name: "Dupont SA",
        street: "Gare 12",
        postalCode: "1003",
        city: "Lausanne",
        country: "CH",
        reference: ""
      },
      lines: [{ name: "Conseil", quantity: 100, unitMinor: 10_000, vatRate: 0 }],
      dueDate: "2026-12-03",
      terms: "",
      legal: "",
      redirectUrl: null,
      language: "fr",
      timeZone: "Europe/Zurich"
    })
  );
}

/** The payer's page: an invoice of the merchant's address declared for `saleKey`'s sale, paid. */
function payLightning(saleKey: Uint8Array, sats: bigint, timestamp: number, expiry = 600) {
  const sale = linkSale(
    saleKey,
    { registryKey: bytesToHex(world.registryKey), registryReader: world.reader },
    ""
  );
  const made = world.breezInvoice(sats, timestamp, expiry);
  world.store(
    declarationEvent({
      sale,
      invoice: made.pr,
      verifyUrl: made.verify,
      paymentHash: made.paymentHash,
      price: { minor: 10_000, digits: 2, currency: "CHF" },
      note: "",
      createdAt: timestamp
    })
  );
  world.paid.add(made.paymentHash);
  return made;
}

/** The sale's owner secret, as the merchant's app computes it (owner-key.ts). */
function saleOwnerSecret(saleKey: Uint8Array): Uint8Array {
  const order = secp256k1.Point.Fn.ORDER;
  const tweak =
    BigInt(
      `0x${bytesToHex(sha256(concatBytes(utf8ToBytes("sattle.me/payment-link/owner/v1"), hexToBytes(world.linkOwner), saleKey)))}`
    ) % order;
  const secret = BigInt(`0x${bytesToHex(world.ownerLinkSecret)}`);
  const even = secp256k1.Point.BASE.multiply(secret).toAffine().y % 2n === 0n;
  const tweaked = ((even ? secret : order - secret) + tweak) % order;
  return hexToBytes(tweaked.toString(16).padStart(64, "0"));
}

/** The link of `made` as published (its payload). */
function payloadOf(made: MadeInvoice) {
  const saleKey = hexToBytes(made.invoice.sent.link.key);
  const copy = world.net
    .get(world.relays[0]!)
    .events.find((event) => (event as { pubkey: string }).pubkey === made.invoice.sent.link.id);
  const opened = openRecord(copy, {
    type: "payment-link",
    encryptionKey: saleKey,
    address: linkAddress(saleKey),
    author: made.invoice.sent.link.id,
    parse: (v) =>
      v as Record<string, unknown> & {
        note: string;
        fiat: { minor: number; digits: number; currency: string };
        onchainAddress: string | null;
      }
  });
  if (opened?.status !== "ok") throw new Error("No link");
  return opened.value;
}

/** The merchant's final version of the link of `made`, with `final`. */
function finalize(
  made: MadeInvoice,
  final: Record<string, unknown>,
  at: number,
  payload: Record<string, unknown> = {}
) {
  const saleKey = hexToBytes(made.invoice.sent.link.key);
  world.store(
    sealRecord({
      type: "payment-link",
      value: {
        ...payloadOf(made),
        ...payload,
        final: { link: made.invoice.sent.link.id, ...final }
      },
      signer: saleOwnerSecret(saleKey),
      encryptionKey: saleKey,
      address: ownerFinalAddress(made.invoice.sent.link.id),
      createdAt: at
    })
  );
}

describe("an invoice's link", () => {
  it("is a line once its proofs prove a payment, with the invoice's number and recipient", async () => {
    const made = await make();
    // Paid a minute after it was sent; read half an hour later.
    const paidAt = world.now + 60;
    const paid = payLightning(hexToBytes(made.invoice.sent.link.key), 125_000n, paidAt);
    world.now += 1800;
    const { lines, setAside, sales } = await read();
    expect(setAside).toEqual([]);
    expect(sales).toEqual(new Set([identityOf(made.invoice.sent.link.key)]));
    expect(lines).toEqual([
      {
        id: `link:${made.invoice.sent.link.id}`,
        source: "link",
        at: paidAt,
        note: payloadOf(made).note,
        invoice: { number: "2026-0001", recipient: "Dupont SA" },
        by: { kind: "seat", name: "Claude" },
        payments: [
          {
            id: paid.paymentHash,
            direction: "receive",
            status: "completed",
            amountSats: "125000",
            feeSats: "0",
            timestamp: paidAt,
            network: "lightning",
            paymentHash: paid.paymentHash,
            txId: null,
            lightningAddress: null,
            description: null
          }
        ],
        sats: "125000",
        fiat: payloadOf(made).fiat,
        rate: null,
        imported: false,
        acceptance: null
      }
    ]);
  });

  it("is told by its final version when there is one", async () => {
    const made = await make();
    // Paid a minute after it was sent; read half an hour later.
    const paidAt = world.now + 60;
    const paid = payLightning(hexToBytes(made.invoice.sent.link.key), 125_000n, paidAt);
    world.now += 1800;
    const point = { hour: pointHour(paidAt), rate: PRICE };
    finalize(
      made,
      {
        status: "paid",
        received: "125000",
        due: "125000",
        point,
        lightning: [{ invoice: paid.pr, preimage: paid.preimage }],
        onchain: null
      },
      world.now - 100,
      // Nothing paid its address: the final version names none.
      { onchainAddress: null }
    );
    // Whatever breez.tips would say now: the final version prevails.
    world.paid.delete(paid.paymentHash);
    const { lines } = await read();
    expect(lines.map(({ sats, at }) => [sats, at])).toEqual([["125000", paidAt]]);
  });

  it("paid short is a line once the merchant accepted it", async () => {
    const made = await make();
    const saleKey = hexToBytes(made.invoice.sent.link.key);
    const address = payloadOf(made).onchainAddress!;
    const id = txid("short link");
    finalize(
      made,
      {
        status: "underpaid",
        received: "120000",
        due: "125000",
        point: { hour: pointHour(world.now - 900), rate: PRICE },
        lightning: [],
        onchain: {
          address,
          transactions: [{ txid: id, receivedAt: (world.now - 900) * 1000, sats: "120000" }],
          sats: "120000"
        }
      },
      world.now - 100
    );
    expect((await read()).lines).toEqual([]);
    const { address: d, encryptionKey } = acceptanceKeys(saleKey);
    world.store(
      sealRecord({
        type: "sale-accepted",
        value: { version: 1, received: "120000", due: "125000" },
        signer: saleOwnerSecret(saleKey),
        encryptionKey,
        address: d,
        createdAt: world.now - 50
      })
    );
    expect((await read()).lines).toMatchObject([
      {
        at: world.now - 900,
        sats: "120000",
        // 100.00 × 120 000 / 125 000.
        fiat: { minor: 9_600, digits: 2, currency: "CHF" },
        acceptance: { received: "120000", due: "125000", at: world.now - 50 }
      }
    ]);
  });

  it("is set aside while a transaction paying it is not 3 blocks deep", async () => {
    const made = await make();
    const address = payloadOf(made).onchainAddress!;
    const id = txid("young");
    world.chain.add(address, payment(id, address, 125_000, { height: world.chain.height }));
    world.chain.received.set(id, new Date((world.now - 300) * 1000).toISOString());
    const { lines, setAside } = await read();
    expect(lines).toEqual([]);
    expect(setAside).toMatchObject([{ reason: "confirming", at: world.now - 300 }]);
  });

  it("is no line once its final version says it ended unpaid, whatever its proofs", async () => {
    const made = await make();
    const paidAt = world.now + 60;
    payLightning(hexToBytes(made.invoice.sent.link.key), 125_000n, paidAt);
    world.now += 1800;
    finalize(
      made,
      { status: "expired", received: "0", due: null, point: null, lightning: [], onchain: null },
      world.now - 100,
      { onchainAddress: null }
    );
    expect(await read()).toMatchObject({ lines: [], setAside: [] });
  });

  it("is no line of a period it was not paid in", async () => {
    const made = await make();
    payLightning(hexToBytes(made.invoice.sent.link.key), 125_000n, world.now + 60);
    const before = { start: world.now - 3 * 86_400, end: world.now - 2 * 86_400 };
    expect((await read(before)).lines).toEqual([]);
  });

  it("is not told without a majority of the relays", async () => {
    await make();
    await world.net.remove(world.relays[0]!);
    await world.net.remove(world.relays[1]!);
    await expect(read()).rejects.toMatchObject({ code: "network" });
  });
});

describe("a link a point of sale shared (version 3)", () => {
  const SALE_KEY = bytes(63);
  const LINK_SECRET = bytes(64);
  const linkAuthor = bytesToHex(schnorr.getPublicKey(LINK_SECRET));

  function shareLink(endsAt: number) {
    const payload = {
      version: 3,
      businessName: "Marie Conseil",
      lightningAddress: LIGHTNING_ADDRESS,
      fiat: { minor: 1_250, digits: 2, currency: "CHF" },
      note: "Table 4",
      onchainAddress: null,
      endsAt,
      registryKey: bytesToHex(world.registryKey),
      registryReader: world.reader,
      owner: world.linkOwner
    };
    world.store(
      sealRecord({
        type: "payment-link",
        value: payload,
        signer: LINK_SECRET,
        encryptionKey: SALE_KEY,
        address: linkAddress(SALE_KEY),
        createdAt: endsAt - 600
      })
    );
    world.store(
      sealRecord({
        type: "team-link",
        value: {
          version: 1,
          link: linkAuthor,
          saleKey: bytesToHex(SALE_KEY),
          createdAt: endsAt - 600,
          onchainTag: null,
          relays: world.relays,
          sealedKey: "c2VhbGVk"
        },
        signer: EMPLOYEE_SECRET,
        encryptionKey: hexToBytes(employee.encryptionKey),
        address: bytesToHex(
          hmac(sha256, hexToBytes(employee.addressKey), utf8ToBytes(`link:${linkAuthor}`))
        ),
        createdAt: endsAt - 600
      })
    );
    return payload;
  }

  it("is read as the payer's page reads it: a sale of 10 minutes until its end", () => {
    const payload = shareLink(world.now - 1200);
    expect(parseLinkPayload(payload)).toBeNull();
    expect(parseLinkPayload(payload, { pointOfSale: true })).toMatchObject({
      startsAt: world.now - 1800,
      endsAt: world.now - 1200
    });
    expect(parseLinkPayload({ ...payload, startsAt: 1 }, { pointOfSale: true })).toBeNull();
  });

  it("is a line of its employee once its proofs prove a payment", async () => {
    shareLink(world.now - 1200);
    payLightning(SALE_KEY, 15_625n, world.now - 1500, 300);
    const { lines, sales } = await read();
    expect(sales.has(identityOf(bytesToHex(SALE_KEY)))).toBe(true);
    expect(lines).toMatchObject([
      {
        id: `link:${linkAuthor}`,
        note: "Table 4",
        by: { kind: "seat", name: "Julie" },
        invoice: null,
        sats: "15625",
        at: world.now - 1500
      }
    ]);
  });
});
