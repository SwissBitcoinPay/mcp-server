import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { declarationEvent } from "../vendor/checkout-node/src/declaration.js";
import type { NostrEvent } from "../vendor/checkout-node/src/nostr/event.js";
import { sealRecord } from "../vendor/checkout-node/src/nostr/record.js";
import { depositAddress, payment, txid } from "../vendor/checkout-node/test/helpers/chain.js";

import { readTillLines, type TillSeat } from "../src/export/sources/till.js";
import { withCall } from "../src/protocol/context.js";
import { acceptanceKeys } from "../src/protocol/follow/sale.js";
import { linkSale } from "../src/protocol/link.js";

import { World, bytes, type BreezInvoice } from "./helpers/world.js";

/*
 * The sales of the points of sale (SPEC.md §20): the records a device of the business publishes of
 * each sale, as the merchant's app writes them (src/lib/team/member-records.ts), each payment checked
 * before it counts; a sale whose payment is not proven is set aside, never a line.
 */

let world: World;
const SEAT_SECRET = bytes(20);
const seat: TillSeat = {
  by: { kind: "seat", name: "Julie" },
  author: bytesToHex(schnorr.getPublicKey(SEAT_SECRET)),
  encryptionKey: bytesToHex(bytes(21)),
  addressKey: bytesToHex(bytes(22)),
  removedAt: null
};
const FIAT = { minor: 1_250, digits: 2, currency: "CHF" };
/** The period: the test's day (03.11.2026, UTC). */
const DAY = { start: 1_793_664_000, end: 1_793_750_399 };

beforeEach(async () => {
  world = await new World().start();
  world.now = DAY.end + 7200;
});

afterEach(async () => {
  await world.stop();
});

function recordAddress(subject: string): string {
  return bytesToHex(hmac(sha256, hexToBytes(seat.addressKey), utf8ToBytes(subject)));
}

/** A sale of the till, its key `seed`'s, as its registry knows it. */
function tillSale(seed: number) {
  const key = bytes(seed);
  const sale = linkSale(
    key,
    { registryKey: bytesToHex(world.registryKey), registryReader: world.reader },
    "0".repeat(64)
  );
  return { key, sale, identity: sale.author };
}

type TillSale = ReturnType<typeof tillSale>;

/** The device declares `invoice` for `of` in the registry, as before it shows its code. */
function declare(of: TillSale, invoice: BreezInvoice) {
  world.store(
    declarationEvent({
      sale: of.sale,
      invoice: invoice.pr,
      verifyUrl: invoice.verify,
      paymentHash: invoice.paymentHash,
      price: FIAT,
      note: "Café",
      createdAt: invoice.timestamp
    })
  );
}

function publish(type: string, value: Record<string, unknown>, subject: string, at: number) {
  const event = sealRecord({
    type,
    value,
    signer: SEAT_SECRET,
    encryptionKey: hexToBytes(seat.encryptionKey),
    address: recordAddress(subject),
    createdAt: at
  });
  world.store(event);
  return event;
}

/** The device's record of `invoice` for `of`, with `extra` (paidAt, lightning, underpaid…). */
function saleRecord(
  of: TillSale,
  invoice: BreezInvoice,
  extra: Record<string, unknown> = {},
  onchainAddress: string | null = null
): NostrEvent {
  const value = {
    version: 1,
    sats: invoice.sats.toString(),
    fiat: FIAT,
    note: "Café",
    createdAt: invoice.timestamp,
    expiresAt: invoice.timestamp + invoice.expiry,
    paidAt: null,
    onchainTag: null,
    sale: of.identity,
    saleKey: bytesToHex(of.key),
    paymentHash: invoice.paymentHash,
    verifyUrl: invoice.verify,
    onchainAddress,
    ...extra
  };
  const at = Math.max(
    (value.paidAt as number | null) ?? value.createdAt,
    (value as { underpaid?: { at: number } }).underpaid?.at ?? 0
  );
  return publish("team-sale", value, `sale:${invoice.paymentHash}`, at);
}

/** The device's record of an hour of `of` that showed `address` alone. */
function onchainRecord(of: TillSale, address: string, hour: number, extra = {}) {
  const value = {
    version: 1,
    sats: "13000",
    fiat: FIAT,
    note: "Café",
    createdAt: hour + 600,
    expiresAt: hour + 1200,
    paidAt: null,
    onchainTag: null,
    sale: of.identity,
    saleKey: bytesToHex(of.key),
    hour,
    onchainAddress: address,
    ...extra
  };
  const at = Math.max(
    (value.paidAt as number | null) ?? value.createdAt,
    (value as { underpaid?: { at: number } }).underpaid?.at ?? 0
  );
  return publish("team-sale-onchain", value, `sale-onchain:${of.identity}:${hour}`, at);
}

/** The device saw `id` paying `address`, at `at`. */
function sighting(address: string, id: string, at: number) {
  return publish("team-sale-tx", { version: 1, address, txid: id }, `sale-tx:${address}:${id}`, at);
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

function accept(of: TillSale, received: bigint, due: bigint, at: number) {
  const { address, encryptionKey } = acceptanceKeys(of.key);
  world.store(
    sealRecord({
      type: "sale-accepted",
      value: { version: 1, received: received.toString(), due: due.toString() },
      signer: saleOwnerSecret(of.key),
      encryptionKey,
      address,
      createdAt: at
    })
  );
}

function read(range = DAY, seats: TillSeat[] = [seat]) {
  return withCall(world.services(), (call) =>
    readTillLines(call, {
      relays: world.relays,
      seats,
      auth: world.keys.member.nostr,
      registryKey: bytesToHex(world.registryKey),
      linkOwner: world.linkOwner,
      bitcoinNode: null,
      range
    })
  );
}

const T = DAY.start + 36_000; // 10:00 UTC

describe("a sale paid over Lightning", () => {
  it("is a line once its proof and its declaration say so", async () => {
    const of = tillSale(30);
    const invoice = world.breezInvoice(13_000n, T, 600);
    declare(of, invoice);
    saleRecord(of, invoice);
    saleRecord(of, invoice, {
      paidAt: T + 42,
      lightning: [{ invoice: invoice.pr, preimage: invoice.preimage }]
    });
    const { lines, setAside } = await read();
    expect(setAside).toEqual([]);
    expect(lines).toEqual([
      {
        id: `sale:${of.identity}`,
        source: "pos",
        at: T + 42,
        note: "Café",
        invoice: null,
        by: { kind: "seat", name: "Julie" },
        payments: [
          {
            id: invoice.paymentHash,
            direction: "receive",
            status: "completed",
            amountSats: "13000",
            feeSats: "0",
            timestamp: T + 42,
            network: "lightning",
            paymentHash: invoice.paymentHash,
            txId: null,
            lightningAddress: null,
            description: null
          }
        ],
        sats: "13000",
        fiat: FIAT,
        rate: null,
        imported: false,
        acceptance: null
      }
    ]);
  });

  it("is set aside when its proof does not prove it", async () => {
    const of = tillSale(31);
    const invoice = world.breezInvoice(13_000n, T, 600);
    declare(of, invoice);
    saleRecord(of, invoice, {
      paidAt: T + 42,
      lightning: [{ invoice: invoice.pr, preimage: "ab".repeat(32) }]
    });
    const { lines, setAside } = await read();
    expect(lines).toEqual([]);
    expect(setAside).toEqual([
      {
        sale: of.identity,
        at: T + 42,
        note: "Café",
        fiat: FIAT,
        by: seat.by,
        reason: "unproven"
      }
    ]);
  });

  it("is set aside when another sale declared its invoice, or none did", async () => {
    const of = tillSale(32);
    const invoice = world.breezInvoice(13_000n, T, 600);
    declare(of, invoice);
    declare(tillSale(33), invoice);
    saleRecord(of, invoice, {
      paidAt: T + 42,
      lightning: [{ invoice: invoice.pr, preimage: invoice.preimage }]
    });
    const undeclared = tillSale(34);
    const other = world.breezInvoice(14_000n, T + 60, 600);
    saleRecord(undeclared, other, {
      paidAt: T + 99,
      lightning: [{ invoice: other.pr, preimage: other.preimage }]
    });
    const { lines, setAside } = await read();
    expect(lines).toEqual([]);
    expect(setAside.map(({ sale, reason }) => [sale, reason])).toEqual([
      [of.identity, "conflict"],
      [undeclared.identity, "unproven"]
    ]);
  });

  it("is told by its Lightning address when its record holds no proof (an app from before)", async () => {
    const paid = tillSale(35);
    const invoice = world.breezInvoice(13_000n, T, 600);
    declare(paid, invoice);
    saleRecord(paid, invoice, { paidAt: T + 42 });
    world.paid.add(invoice.paymentHash);
    const unpaid = tillSale(36);
    const other = world.breezInvoice(14_000n, T + 60, 600);
    declare(unpaid, other);
    saleRecord(unpaid, other, { paidAt: T + 99 });
    const { lines, setAside } = await read();
    expect(lines.map(({ id, sats }) => [id, sats])).toEqual([[`sale:${paid.identity}`, "13000"]]);
    expect(setAside.map(({ sale, reason }) => [sale, reason])).toEqual([
      [unpaid.identity, "unproven"]
    ]);
  });

  it("is not a line of a period it was not paid in, nor before it is paid", async () => {
    const of = tillSale(37);
    const invoice = world.breezInvoice(13_000n, DAY.start - 700, 600);
    declare(of, invoice);
    saleRecord(of, invoice, {
      paidAt: DAY.start - 60,
      lightning: [{ invoice: invoice.pr, preimage: invoice.preimage }]
    });
    const open = tillSale(38);
    const shown = world.breezInvoice(13_000n, T, 600);
    declare(open, shown);
    saleRecord(open, shown);
    expect(await read()).toEqual({ lines: [], setAside: [] });
    // The day before holds it.
    const before = await read({ start: DAY.start - 86_400, end: DAY.start - 1 });
    expect(before.lines.map(({ at }) => at)).toEqual([DAY.start - 60]);
  });
});

describe("a sale paid on-chain", () => {
  const address = depositAddress("till 1");
  const hour = T - (T % 3600);

  it("is a line once the transactions its device saw are 3 blocks deep", async () => {
    const of = tillSale(40);
    const id = txid("till pay 1");
    world.chain.add(address, payment(id, address, 13_000, { height: world.chain.height - 2 }));
    world.chain.received.set(id, "2026-11-03T10:12:30.5Z");
    onchainRecord(of, address, hour, { paidAt: T + 1800, lightning: [] });
    sighting(address, id, T + 750);
    const { lines, setAside } = await read();
    expect(setAside).toEqual([]);
    expect(lines).toMatchObject([
      {
        id: `sale:${of.identity}`,
        at: T + 750,
        sats: "13000",
        payments: [
          {
            id,
            network: "bitcoin",
            txId: id,
            paymentHash: null,
            amountSats: "13000",
            timestamp: T + 750
          }
        ]
      }
    ]);
  });

  it("is set aside while they are not, and leaves out a transaction it did not see", async () => {
    const of = tillSale(41);
    const id = txid("till pay 2");
    world.chain.add(address, payment(id, address, 13_000, { height: world.chain.height - 1 }));
    world.chain.received.set(id, "2026-11-03T10:12:30Z");
    onchainRecord(of, address, hour, { paidAt: T + 1800, lightning: [] });
    sighting(address, id, T + 750);
    expect((await read()).setAside.map(({ reason }) => reason)).toEqual(["confirming"]);
    // Another transaction paying the address, which its device never saw: not the sale's.
    const stranger = tillSale(42);
    const elsewhere = depositAddress("till 2");
    const unseen = txid("till pay 3");
    world.chain.add(elsewhere, payment(unseen, elsewhere, 13_000, { height: 960_000 }));
    world.chain.received.set(unseen, "2026-11-03T10:12:30Z");
    onchainRecord(stranger, elsewhere, hour, { paidAt: T + 1800, lightning: [] });
    const { lines, setAside } = await read();
    expect(lines).toEqual([]);
    // Both seen paid at the same second: by sale.
    expect(setAside.map(({ sale, reason }) => [sale, reason])).toEqual(
      [
        [of.identity, "confirming"],
        [stranger.identity, "unproven"]
      ].sort(([a], [b]) => (a! < b! ? -1 : 1))
    );
  });

  it("is not told when the explorer cannot tell it", async () => {
    const of = tillSale(43);
    const id = txid("till pay 4");
    world.chain.add(address, payment(id, address, 13_000, { height: 960_000 }));
    onchainRecord(of, address, hour, { paidAt: T + 1800, lightning: [] });
    sighting(address, id, T + 750);
    world.chain.down.add("mempool");
    await expect(read()).rejects.toMatchObject({ code: "network" });
  });
});

describe("a sale paid short", () => {
  const address = depositAddress("till short");
  const hour = T - (T % 3600);

  function underpaidSale(seed: number) {
    const of = tillSale(seed);
    const id = txid(`short ${seed}`);
    world.chain.add(address, payment(id, address, 12_000, { height: 960_000 }));
    world.chain.received.set(id, "2026-11-03T10:15:00Z");
    onchainRecord(of, address, hour, {
      underpaid: { at: T + 2400, received: "12000", due: "13000", transactions: [id] }
    });
    return { of, id };
  }

  it("is no line while the merchant has not accepted it", async () => {
    underpaidSale(44);
    expect(await read()).toEqual({ lines: [], setAside: [] });
  });

  it("is a line once accepted, at what it received", async () => {
    const { of } = underpaidSale(45);
    accept(of, 12_000n, 13_000n, T + 3000);
    const { lines } = await read();
    expect(lines).toMatchObject([
      {
        id: `sale:${of.identity}`,
        at: T + 900,
        sats: "12000",
        // 12.50 × 12 000 / 13 000, rounded down (the app's splitFiat).
        fiat: { minor: 1_153, digits: 2, currency: "CHF" },
        acceptance: { received: "12000", due: "13000", at: T + 3000, fiat: FIAT }
      }
    ]);
  });
});

describe("the records", () => {
  it("are never read past one of a newer format", async () => {
    const of = tillSale(46);
    const invoice = world.breezInvoice(13_000n, T, 600);
    saleRecord(of, invoice, { version: 2 });
    await expect(read()).rejects.toMatchObject({ code: "newer" });
  });

  it("are not told without a majority of the relays", async () => {
    await world.net.remove(world.relays[0]!);
    await world.net.remove(world.relays[1]!);
    await expect(read()).rejects.toMatchObject({ code: "network" });
  });

  it("of a device removed from the team count for what it saw before only", async () => {
    const before = tillSale(48);
    const invoice = world.breezInvoice(13_000n, T, 600);
    declare(before, invoice);
    saleRecord(before, invoice, {
      paidAt: T + 42,
      lightning: [{ invoice: invoice.pr, preimage: invoice.preimage }]
    });
    const after = tillSale(49);
    const later = world.breezInvoice(14_000n, T + 600, 600);
    declare(after, later);
    saleRecord(after, later, {
      paidAt: T + 700,
      lightning: [{ invoice: later.pr, preimage: later.preimage }]
    });
    const { lines } = await read(DAY, [{ ...seat, removedAt: T + 100 }]);
    expect(lines.map(({ id }) => id)).toEqual([`sale:${before.identity}`]);
  });

  it("are a seat's own: another author's are left out", async () => {
    const of = tillSale(47);
    const invoice = world.breezInvoice(13_000n, T, 600);
    declare(of, invoice);
    saleRecord(of, invoice, {
      paidAt: T + 42,
      lightning: [{ invoice: invoice.pr, preimage: invoice.preimage }]
    });
    const stranger: TillSeat = { ...seat, author: bytesToHex(schnorr.getPublicKey(bytes(23))) };
    expect(await read(DAY, [stranger])).toEqual({ lines: [], setAside: [] });
  });
});
