import { schnorr } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { declarationEvent } from "../vendor/checkout-node/src/declaration.js";
import type { NostrEvent } from "../vendor/checkout-node/src/nostr/event.js";
import { sealRecord } from "../vendor/checkout-node/src/nostr/record.js";
import { witnessEvent } from "../vendor/checkout-node/src/onchain/witness.js";
import { depositAddress, txid } from "../vendor/checkout-node/test/helpers/chain.js";

import {
  openLightningWitness,
  readIntegrationLines,
  type IntegrationSeat
} from "../src/export/sources/integrations.js";
import { withCall } from "../src/protocol/context.js";
import { linkSale } from "../src/protocol/link.js";

import { World, bytes, type BreezInvoice } from "./helpers/world.js";

/*
 * The integrations' sales (SPEC.md §20): the Lightning witnesses their servers publish (checkout-spec
 * SPEC.md §32, its vectors), each payment counted by its declaration and the merchant's Lightning
 * address; an order paid on-chain set aside.
 */

const witnessVectors = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "spec", "vectors", "lightning-witnesses.json"),
    "utf8"
  )
) as {
  channelEncryptionKey: string;
  derived: { paidAuthor: string; paidAddressKey: string };
  events: { name: string; event: NostrEvent; value: Record<string, unknown> | "newer" | null }[];
};

describe("a Lightning witness", () => {
  const keys = {
    author: witnessVectors.derived.paidAuthor,
    addressKey: hexToBytes(witnessVectors.derived.paidAddressKey),
    encryptionKey: hexToBytes(witnessVectors.channelEncryptionKey)
  };

  it.each(witnessVectors.events.map((entry) => [entry.name, entry] as const))(
    "opens as the specification's vectors say: %s",
    (_, { event, value }) => {
      const opened = openLightningWitness(event, keys);
      if (value === null) expect(opened).toBeNull();
      else if (value === "newer") expect(opened?.status).toBe("newer");
      else {
        expect(opened?.status).toBe("ok");
        expect(opened?.status === "ok" ? opened.value : null).toEqual(value);
      }
    }
  );
});

let world: World;
const PAID_SECRET = bytes(70);
const SEEN_SECRET = bytes(71);
const CHANNEL_KEY = bytes(72);
const PAID_ADDRESS_KEY = bytes(73);
const SEEN_ADDRESS_KEY = bytes(74);
const seat: IntegrationSeat = {
  name: "Boutique",
  channelKey: bytesToHex(CHANNEL_KEY),
  paid: {
    author: bytesToHex(schnorr.getPublicKey(PAID_SECRET)),
    addressKey: bytesToHex(PAID_ADDRESS_KEY)
  },
  seen: {
    author: bytesToHex(schnorr.getPublicKey(SEEN_SECRET)),
    addressKey: bytesToHex(SEEN_ADDRESS_KEY)
  },
  removedAt: null
};
const PRICE = { minor: 4_900, digits: 2, currency: "CHF" };

beforeEach(async () => {
  world = await new World().start();
});

afterEach(async () => {
  await world.stop();
});

const day = () => ({ start: world.now - 43_200, end: world.now + 43_199 });

function read(range = day(), seats: IntegrationSeat[] = [seat]) {
  return withCall(world.services(), (call) =>
    readIntegrationLines(call, {
      relays: world.relays,
      seats,
      auth: world.keys.member.nostr,
      registryKey: bytesToHex(world.registryKey),
      registryReader: bytesToHex(world.readerSecret),
      lightningAddress: "sattleme02c6047f94@breez.tips",
      range
    })
  );
}

function orderSale(seed: number) {
  return linkSale(
    bytes(seed),
    { registryKey: bytesToHex(world.registryKey), registryReader: world.reader },
    "0".repeat(32)
  );
}

/** The integration's server declares `invoice` for `sale` (its order). */
function declare(sale: ReturnType<typeof orderSale>, invoice: BreezInvoice, price = PRICE) {
  world.store(
    declarationEvent({
      sale,
      invoice: invoice.pr,
      verifyUrl: invoice.verify,
      paymentHash: invoice.paymentHash,
      price,
      note: "Commande 42",
      createdAt: invoice.timestamp
    })
  );
}

/** The integration's server saw `invoice` paid at `at`. */
function witness(invoice: BreezInvoice, at: number, version = 1) {
  world.store(
    sealRecord({
      type: "integration-lightning-paid",
      value: {
        version,
        invoice: invoice.pr,
        verifyUrl: invoice.verify,
        preimage: invoice.preimage
      },
      signer: PAID_SECRET,
      encryptionKey: CHANNEL_KEY,
      address: bytesToHex(hmac(sha256, PAID_ADDRESS_KEY, hexToBytes(invoice.paymentHash))),
      createdAt: at
    })
  );
}

describe("an integration's sale paid over Lightning", () => {
  it("is a line once declared by its sale alone and told paid by the Lightning address", async () => {
    const sale = orderSale(80);
    const invoice = world.breezInvoice(61_250n, world.now - 900, 600);
    declare(sale, invoice);
    world.paid.add(invoice.paymentHash);
    witness(invoice, world.now - 850);
    const { lines, setAside } = await read();
    expect(setAside).toEqual([]);
    expect(lines).toEqual([
      {
        id: `sale:${sale.author}`,
        source: "integration",
        at: world.now - 850,
        note: "Commande 42",
        invoice: null,
        by: { kind: "seat", name: "Boutique" },
        payments: [
          {
            id: invoice.paymentHash,
            direction: "receive",
            status: "completed",
            amountSats: "61250",
            feeSats: "0",
            timestamp: world.now - 850,
            network: "lightning",
            paymentHash: invoice.paymentHash,
            txId: null,
            lightningAddress: null,
            description: null
          }
        ],
        sats: "61250",
        fiat: PRICE,
        rate: null,
        imported: false,
        acceptance: null
      }
    ]);
  });

  it("asked in sats is valued as a transfer (no amount of its own)", async () => {
    const sale = orderSale(81);
    const invoice = world.breezInvoice(5_000n, world.now - 900, 600);
    declare(sale, invoice, { minor: 5_000, digits: 0, currency: "SAT" });
    world.paid.add(invoice.paymentHash);
    witness(invoice, world.now - 850);
    expect((await read()).lines.map(({ fiat }) => fiat)).toEqual([null]);
  });

  it("is set aside when the Lightning address does not tell it paid, or its sale is not alone", async () => {
    const unpaid = orderSale(82);
    const first = world.breezInvoice(61_250n, world.now - 900, 600);
    declare(unpaid, first);
    witness(first, world.now - 850);
    const twice = world.breezInvoice(61_250n, world.now - 800, 600);
    declare(orderSale(83), twice);
    declare(orderSale(84), twice);
    world.paid.add(twice.paymentHash);
    witness(twice, world.now - 750);
    const { lines, setAside } = await read();
    expect(lines).toEqual([]);
    expect(setAside.map(({ at, reason }) => [at, reason])).toEqual([
      [world.now - 850, "unproven"],
      [world.now - 750, "conflict"]
    ]);
  });

  it("is never read past a witness of a newer format", async () => {
    const invoice = world.breezInvoice(61_250n, world.now - 900, 600);
    witness(invoice, world.now - 850, 2);
    await expect(read()).rejects.toMatchObject({ code: "newer" });
  });

  it("of an integration removed since counts for what it saw before only", async () => {
    const sale = orderSale(85);
    const invoice = world.breezInvoice(61_250n, world.now - 900, 600);
    declare(sale, invoice);
    world.paid.add(invoice.paymentHash);
    witness(invoice, world.now - 850);
    expect((await read(day(), [{ ...seat, removedAt: world.now - 860 }])).lines).toEqual([]);
  });
});

describe("an integration's order paid on-chain", () => {
  it("is set aside: the merchant's app tells it", async () => {
    const sale = orderSale(86);
    const address = depositAddress("order 86");
    world.store(
      witnessEvent(
        {
          secretKey: SEEN_SECRET,
          author: seat.seen.author,
          addressKey: SEEN_ADDRESS_KEY,
          encryptionKey: CHANNEL_KEY
        },
        {
          address,
          txid: txid("order 86"),
          sale: sale.author,
          sats: 49_000n,
          inputs: [`${txid("coin")}:0`],
          replacement: false,
          expiresAt: world.now
        },
        world.now - 600
      )
    );
    const { lines, setAside } = await read();
    expect(lines).toEqual([]);
    expect(setAside).toEqual([
      {
        sale: sale.author,
        at: world.now - 600,
        note: "",
        fiat: null,
        by: { kind: "seat", name: "Boutique" },
        reason: "onchain"
      }
    ]);
  });
});
