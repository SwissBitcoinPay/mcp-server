import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { declarationEvent } from "../vendor/checkout-node/src/declaration.js";
import { openRecord, sealRecord } from "../vendor/checkout-node/src/nostr/record.js";
import { secureRandomBytes } from "../vendor/checkout-node/src/random.js";
import { depositAddress, payment, txid } from "../vendor/checkout-node/test/helpers/chain.js";

import { readChannel } from "../src/protocol/channel.js";
import { withCall } from "../src/protocol/context.js";
import { followInvoice } from "../src/protocol/follow/follow.js";
import type { Invoice } from "../src/protocol/invoice.js";
import { linkAddress, linkSale, ownerFinalAddress } from "../src/protocol/link.js";
import { makeInvoice, type MadeInvoice } from "../src/protocol/make.js";
import { acceptanceKeys } from "../src/protocol/follow/sale.js";
import { pointHour, satsAt } from "../src/protocol/points.js";

import { World, metadataHash } from "./helpers/world.js";

/*
 * Following an invoice's payment (SPEC.md §15) against local relays, breez.tips, CoinGecko and the
 * explorers: the payer's page declares and pays, the merchant's app settles and accepts, as each
 * of them does.
 */

let world: World;
const lot = [depositAddress("follow 1"), depositAddress("follow 2")];
const PRICE = 80_000;

beforeEach(async () => {
  world = await new World().start();
  world.publishChannel(world.channelValue(world.now - 100), world.now - 100);
  world.publishLot(lot, world.now - 90);
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

async function make(dueDate = "2026-12-03", onchain = true): Promise<MadeInvoice> {
  if (!onchain) {
    const value = world.channelValue(world.now - 50);
    world.publishChannel(
      { ...value, profile: { ...value.profile, onchain: false } },
      world.now - 50
    );
  }
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
      lines: [{ name: "Conseil", quantity: 100, unitMinor: 100_000, vatRate: 0 }],
      dueDate,
      terms: "",
      legal: "",
      redirectUrl: null,
      language: "fr",
      timeZone: "Europe/Zurich"
    })
  );
}

const follow = (invoice: Invoice) =>
  withCall(world.services(), async (call) => {
    const channel = await readChannel(call, world.access, world.keys);
    return followInvoice(call, world.keys, channel, invoice);
  });

/** 1000.00 CHF at 80 000 CHF/BTC. */
const DUE = satsAt(100_000, 2, PRICE);

/** The payer's page: an invoice of the merchant's Lightning address, declared for the sale. */
function declare(invoice: Invoice, sats: bigint, timestamp = world.now, descriptionHash?: string) {
  const saleKey = hexToBytes(invoice.sent.link.key);
  const sale = linkSale(
    saleKey,
    { registryKey: bytesToHex(world.registryKey), registryReader: world.reader },
    ""
  );
  const expiry = Math.min(900, 3900 - ((((timestamp - 300) % 3600) + 3600) % 3600));
  const made = world.breezInvoice(sats, timestamp, expiry, descriptionHash);
  world.store(
    declarationEvent({
      sale,
      invoice: made.pr,
      verifyUrl: made.verify,
      paymentHash: made.paymentHash,
      price: { minor: 100_000, digits: 2, currency: "CHF" },
      note: "Facture 2026-0001",
      createdAt: timestamp
    })
  );
  return made;
}

/** The sale's owner secret, as the merchant's app computes it (owner-key.ts). */
function saleOwnerSecret(saleKey: Uint8Array): Uint8Array {
  const order = secp256k1.Point.Fn.ORDER;
  const owner = bytesToHex(schnorr.getPublicKey(world.ownerLinkSecret));
  const tweak =
    BigInt(
      `0x${bytesToHex(sha256(concatBytes(utf8ToBytes("sattle.me/payment-link/owner/v1"), hexToBytes(owner), saleKey)))}`
    ) % order;
  const secret = BigInt(`0x${bytesToHex(world.ownerLinkSecret)}`);
  const even = secp256k1.Point.BASE.multiply(secret).toAffine().y % 2n === 0n;
  const tweaked = ((even ? secret : order - secret) + tweak) % order;
  return hexToBytes(tweaked.toString(16).padStart(64, "0"));
}

describe("following an invoice", () => {
  it("is open while nothing was paid", async () => {
    const { invoice } = await make();
    const followed = await follow(invoice);
    expect(followed.status).toEqual({ source: "proofs", state: "open" });
  });

  it("is paid as soon as a Lightning invoice of the sale is, with its preimage", async () => {
    const { invoice } = await make("2026-12-03", false);
    const paid = declare(invoice, DUE);
    const before = await follow(invoice);
    expect(before.status.state).toBe("open");
    world.paid.add(paid.paymentHash);
    const after = await follow(invoice);
    expect(after.status).toEqual({
      source: "proofs",
      state: "paid",
      method: "lightning",
      received: DUE,
      due: DUE,
      accepted: false
    });
    expect(after.lightning).toEqual([
      { paymentHash: paid.paymentHash, preimage: paid.preimage, sats: DUE }
    ]);
  });

  it("never counts a payment another sale declared too", async () => {
    const { invoice } = await make("2026-12-03", false);
    const paid = declare(invoice, DUE);
    world.paid.add(paid.paymentHash);
    // Another sale of the merchant claims the same payment.
    const other = linkSale(
      hexToBytes("09".repeat(32)),
      { registryKey: bytesToHex(world.registryKey), registryReader: world.reader },
      ""
    );
    world.store(
      declarationEvent({
        sale: other,
        invoice: paid.pr,
        verifyUrl: paid.verify,
        paymentHash: paid.paymentHash,
        price: { minor: 100_000, digits: 2, currency: "CHF" },
        note: "Autre",
        createdAt: world.now
      })
    );
    expect((await follow(invoice)).status.state).toBe("open");
  });

  it("never counts an invoice of another Lightning service, nor one dated before the sale", async () => {
    const { invoice } = await make("2026-12-03", false);
    const early = declare(invoice, DUE, world.now - 3600);
    world.paid.add(early.paymentHash);
    expect((await follow(invoice)).status.state).toBe("open");
  });

  it("waits for the app when a paid invoice was made under a former name of the business", async () => {
    const { invoice } = await make("2026-12-03", false);
    const paid = declare(invoice, DUE, world.now, metadataHash('[["text/plain","Ancien nom"]]'));
    world.paid.add(paid.paymentHash);
    expect((await follow(invoice)).status).toEqual({
      source: "proofs",
      state: "checking",
      reason: "former_name"
    });
  });

  it("is underpaid with what is left, then paid once the merchant accepted it", async () => {
    const { invoice, onchainAddress } = await make();
    const sent = txid("short");
    world.chain.add(
      onchainAddress!,
      payment(sent, onchainAddress!, 1_000_000, { height: world.chain.height - 5 })
    );
    world.chain.received.set(sent, new Date((world.now + 60) * 1000).toISOString());
    world.now += 120;
    const short = await follow(invoice);
    expect(short.status).toEqual({
      source: "proofs",
      state: "underpaid",
      received: 1_000_000n,
      rest: DUE - 1_000_000n,
      due: null,
      ended: false
    });
    // The merchant accepts it in the app: signed with the sale's owner key.
    const saleKey = hexToBytes(invoice.sent.link.key);
    const { address, encryptionKey } = acceptanceKeys(saleKey);
    world.store(
      sealRecord({
        type: "sale-accepted",
        value: { version: 1, received: "1000000", due: DUE.toString() },
        signer: saleOwnerSecret(saleKey),
        encryptionKey,
        address,
        createdAt: world.now
      })
    );
    expect((await follow(invoice)).status).toMatchObject({
      state: "paid",
      accepted: true,
      received: 1_000_000n
    });
  });

  it("confirms an on-chain payment, then says it paid 3 blocks deep", async () => {
    const { invoice, onchainAddress } = await make();
    const sent = txid("whole");
    world.chain.add(onchainAddress!, payment(sent, onchainAddress!, Number(DUE)));
    // Seen by mempool.space at 10:25, away from a change of point.
    world.firstSeen.set(sent, world.now + 300);
    world.now += 400;
    expect((await follow(invoice)).status).toEqual({
      source: "proofs",
      state: "confirming",
      method: "onchain",
      received: DUE,
      confirmations: 0
    });
    world.chain.confirm(onchainAddress!, sent, world.chain.height - 2);
    world.chain.received.set(sent, new Date((world.now - 100) * 1000).toISOString());
    expect((await follow(invoice)).status).toMatchObject({
      state: "paid",
      method: "onchain",
      received: DUE
    });
  });

  it("waits when the time of a transaction cannot be told", async () => {
    const { invoice, onchainAddress } = await make();
    world.chain.add(
      onchainAddress!,
      payment(txid("unknown"), onchainAddress!, Number(DUE), { height: world.chain.height })
    );
    expect((await follow(invoice)).status).toEqual({
      source: "proofs",
      state: "checking",
      reason: "time"
    });
  });

  it("waits for the price of the hour when CoinGecko does not answer", async () => {
    const { invoice } = await make("2026-12-03", false);
    const paid = declare(invoice, DUE - 1000n);
    world.paid.add(paid.paymentHash);
    world.coingeckoDown = true;
    world.now += 7200;
    expect((await follow(invoice)).status).toEqual({
      source: "proofs",
      state: "checking",
      reason: "price"
    });
  });

  it("is expired once its due date passed without a payment", async () => {
    const { invoice } = await make("2026-11-04", false);
    const unpaid = declare(invoice, DUE);
    world.now = invoice.dueAt + 60;
    // Its invoice ended long ago, but past the end its report is final only after 120 s.
    expect((await follow(invoice)).status).toMatchObject({ state: "expired" });
    expect(world.paid.has(unpaid.paymentHash)).toBe(false);
  });

  it("takes the merchant's final version when there is one", async () => {
    const { invoice } = await make();
    const saleKey = hexToBytes(invoice.sent.link.key);
    const copy = (
      world.net.get(world.relays[0]!).events as { pubkey: string; tags: string[][] }[]
    ).find((event) => event.pubkey === invoice.sent.link.id);
    expect(copy).toBeDefined();
    const payload = (
      openRecord(copy, {
        type: "payment-link",
        encryptionKey: saleKey,
        address: linkAddress(saleKey),
        author: invoice.sent.link.id,
        parse: (v) => v as Record<string, unknown>
      }) as { value: Record<string, unknown> }
    ).value;
    world.store(
      sealRecord({
        type: "payment-link",
        value: {
          ...payload,
          onchainAddress: null,
          final: {
            status: "canceled",
            received: "0",
            due: null,
            point: null,
            lightning: [],
            onchain: null,
            link: invoice.sent.link.id
          }
        },
        signer: saleOwnerSecret(saleKey),
        encryptionKey: saleKey,
        address: ownerFinalAddress(invoice.sent.link.id),
        createdAt: world.now + 10
      })
    );
    expect((await follow(invoice)).status).toEqual({
      source: "final",
      state: "canceled",
      received: 0n,
      due: null,
      accepted: false,
      method: null
    });
  });

  describe("canceled, then paid all the same", () => {
    /** The link's payload as published, its own signing secret, and the sale key. */
    async function made() {
      const drawn: Uint8Array[] = [];
      const services = world.services();
      const { invoice } = await withCall(
        {
          ...services,
          random: (length: number) => {
            const bytes = secureRandomBytes(length);
            drawn.push(bytes);
            return bytes;
          }
        },
        (call) =>
          makeInvoice(call, world.access, world.keys, {
            recipient: {
              name: "Dupont SA",
              street: "Gare 12",
              postalCode: "1003",
              city: "Lausanne",
              country: "CH",
              reference: ""
            },
            lines: [{ name: "Conseil", quantity: 100, unitMinor: 100_000, vatRate: 0 }],
            dueDate: "2026-12-03",
            terms: "",
            legal: "",
            redirectUrl: null,
            language: "fr",
            timeZone: "Europe/Zurich"
          })
      );
      const author = invoice.sent.link.id;
      const linkSecret = drawn.find(
        (bytes) =>
          bytes.length === 32 &&
          (() => {
            try {
              return bytesToHex(schnorr.getPublicKey(bytes)) === author;
            } catch {
              return false;
            }
          })()
      )!;
      const saleKey = hexToBytes(invoice.sent.link.key);
      const copy = (
        world.net.get(world.relays[0]!).events as { pubkey: string; tags: string[][] }[]
      ).find((event) => event.pubkey === author);
      const payload = (
        openRecord(copy, {
          type: "payment-link",
          encryptionKey: saleKey,
          address: linkAddress(saleKey),
          author,
          parse: (v) => v as Record<string, unknown>
        }) as { value: Record<string, unknown> }
      ).value;
      return { invoice, author, linkSecret, saleKey, payload };
    }

    type Made = Awaited<ReturnType<typeof made>>;

    const canceled = (author: string) => ({
      status: "canceled",
      received: "0",
      due: null,
      point: null,
      lightning: [],
      onchain: null,
      link: author
    });

    /** Paid over Lightning, `sats` of the 1000.00 CHF due at the point of this hour. */
    function settled(author: string, sats: bigint) {
      const paid = world.breezInvoice(sats, world.now, 900);
      return {
        status: sats >= DUE ? "paid" : "underpaid",
        received: sats.toString(),
        due: DUE.toString(),
        point: { hour: pointHour(world.now), rate: PRICE },
        lightning: [{ invoice: paid.pr, preimage: paid.preimage }],
        onchain: null,
        link: author
      };
    }

    /** The merchant's final version, at the owner final address, on `relays`. */
    function merchantFinal(
      m: Made,
      final: Record<string, unknown>,
      at: number,
      relays = world.relays
    ) {
      world.store(
        sealRecord({
          type: "payment-link",
          value: { ...m.payload, onchainAddress: null, final },
          signer: saleOwnerSecret(m.saleKey),
          encryptionKey: m.saleKey,
          address: ownerFinalAddress(m.author),
          createdAt: at
        }),
        relays
      );
    }

    it("tells the merchant's settlement over its cancellation, also while a relay keeps it", async () => {
      const m = await made();
      merchantFinal(m, canceled(m.author), world.now + 10);
      expect((await follow(m.invoice)).status).toMatchObject({
        source: "final",
        state: "canceled"
      });
      // The merchant's app settled the sale: one relay missed it and still sends the cancellation.
      merchantFinal(m, settled(m.author, DUE), world.now + 20, world.relays.slice(1));
      expect((await follow(m.invoice)).status).toEqual({
        source: "final",
        state: "paid",
        received: DUE,
        due: DUE,
        accepted: false,
        method: "lightning"
      });
    });

    it("tells an underpayment the merchant settled over its cancellation", async () => {
      const m = await made();
      merchantFinal(m, canceled(m.author), world.now + 10, world.relays.slice(0, 1));
      merchantFinal(m, settled(m.author, DUE - 1000n), world.now + 20, world.relays.slice(1));
      expect((await follow(m.invoice)).status).toMatchObject({
        source: "final",
        state: "underpaid",
        received: DUE - 1000n
      });
    });

    it("never lets the link's own final version undo the merchant's cancellation", async () => {
      const m = await made();
      merchantFinal(m, canceled(m.author), world.now + 10);
      world.store(
        sealRecord({
          type: "payment-link",
          value: { ...m.payload, onchainAddress: null, final: settled(m.author, DUE) },
          signer: m.linkSecret,
          encryptionKey: m.saleKey,
          address: linkAddress(m.saleKey),
          createdAt: world.now + 20
        })
      );
      expect((await follow(m.invoice)).status).toMatchObject({
        source: "final",
        state: "canceled"
      });
    });
  });

  it("never reads a final version signed by another key", async () => {
    const { invoice } = await make();
    const saleKey = hexToBytes(invoice.sent.link.key);
    world.store(
      sealRecord({
        type: "payment-link",
        value: { version: 4, final: { status: "paid" } },
        signer: hexToBytes("0b".repeat(32)),
        encryptionKey: saleKey,
        address: ownerFinalAddress(invoice.sent.link.id),
        createdAt: world.now + 10
      })
    );
    expect((await follow(invoice)).status.state).toBe("open");
  });
});
