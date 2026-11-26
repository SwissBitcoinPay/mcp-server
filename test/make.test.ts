import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { base64UrlToBytes } from "../vendor/checkout-node/src/encoding.js";
import type { NostrEvent } from "../vendor/checkout-node/src/nostr/event.js";
import { conversationKey, nip44Decrypt } from "../vendor/checkout-node/src/nostr/nip44.js";
import { openRecord } from "../vendor/checkout-node/src/nostr/record.js";
import { depositAddress, payment, txid } from "../vendor/checkout-node/test/helpers/chain.js";

import { withCall } from "../src/protocol/context.js";
import {
  counterKeys,
  invoiceAddress,
  linkRecordAddress,
  usedAddress
} from "../src/protocol/keys.js";
import { linkAddress, parseLinkPayload } from "../src/protocol/link.js";
import { parseUsed } from "../src/protocol/lot.js";
import { makeInvoice, type InvoiceRequest } from "../src/protocol/make.js";
import { parseInvoice } from "../src/protocol/invoice.js";
import { readInvoices } from "../src/protocol/read.js";
import { AssistantError } from "../src/protocol/errors.js";

import { World } from "./helpers/world.js";

const request = (extra: Partial<InvoiceRequest> = {}): InvoiceRequest => ({
  recipient: {
    name: "Dupont SA",
    street: "Avenue de la Gare 12",
    postalCode: "1003",
    city: "Lausanne",
    country: "CH",
    reference: "PO-7781"
  },
  lines: [
    { name: "Conseil (jours)", quantity: 300, unitMinor: 120000, vatRate: 810 },
    { name: "Débours", quantity: 100, unitMinor: 1250, vatRate: 0 }
  ],
  dueDate: "2026-12-03",
  terms: "Paiement à 30 jours net.",
  legal: "",
  redirectUrl: "https://marie-conseil.example/merci",
  language: "fr",
  timeZone: "Europe/Zurich",
  ...extra
});

let world: World;
const addresses = [depositAddress("lot 1"), depositAddress("lot 2")];

beforeEach(async () => {
  world = await new World().start();
  world.publishChannel(world.channelValue(world.now - 100), world.now - 100);
  world.publishLot(addresses, world.now - 90);
  world.publishOwnerCounter(2026, 41, world.now - 80);
  world.setPoints("CHF", world.now - 3 * 3600 - (world.now % 3600), world.now, 80_000);
});

afterEach(async () => {
  await world.stop();
});

const make = (extra: Partial<InvoiceRequest> = {}) =>
  withCall(world.services(), (call) => makeInvoice(call, world.access, world.keys, request(extra)));

/** The newest event at `d` of `author` on the first relay. */
function stored(author: string, d: string): NostrEvent | undefined {
  return (world.net.get(world.relays[0]!).events as NostrEvent[]).find(
    (event) =>
      event.pubkey === author && event.tags.some(([name, value]) => name === "d" && value === d)
  );
}

async function failure(promise: Promise<unknown>): Promise<AssistantError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AssistantError) return error;
    throw error;
  }
  throw new Error("No failure");
}

describe("making an invoice", () => {
  it("takes the next number of the series, an address, and publishes the link, its record and the invoice", async () => {
    const made = await make();
    expect(made.number).toBe("2026-0042");
    expect(made.onchainAddress).toBe(addresses[0]);
    expect(made.totals).toEqual({
      netMinor: 361250,
      vat: [{ rate: 810, baseMinor: 360000, vatMinor: 29160 }],
      totalMinor: 390410
    });
    const { invoice } = made;
    expect(invoice.number).toEqual({ year: 2026, sequence: 42 });
    expect(invoice.currency).toEqual({ code: "CHF", digits: 2 });
    // The end of 3 December in Zurich: 23:00 UTC.
    expect(invoice.dueAt).toBe(Date.UTC(2026, 11, 3, 23) / 1000);
    expect(invoice.sent.at).toBe(world.now);

    // The URL names the link's author, the sale key and the merchant's relays.
    const [path, fragment] = made.url.split("#") as [string, string];
    expect(path).toBe("https://pay.example/pay");
    const [author, key, relays] = fragment.split(".") as [string, string, string];
    expect(bytesToHex(base64UrlToBytes(author)!)).toBe(invoice.sent.link.id);
    expect(bytesToHex(base64UrlToBytes(key)!)).toBe(invoice.sent.link.key);
    expect(new TextDecoder().decode(base64UrlToBytes(relays)!)).toBe(
      "relay-a.test,relay-b.test,relay-c.test"
    );

    // The link, as the payer's page reads it.
    const saleKey = hexToBytes(invoice.sent.link.key);
    const linkCopy = stored(invoice.sent.link.id, linkAddress(saleKey))!;
    const payload = openRecord(linkCopy, {
      type: "payment-link",
      encryptionKey: saleKey,
      address: linkAddress(saleKey),
      author: invoice.sent.link.id,
      parse: (value) => parseLinkPayload(value)
    });
    expect(payload?.status).toBe("ok");
    const sale = (payload as { value: ReturnType<typeof parseLinkPayload> }).value!;
    expect(sale).toMatchObject({
      businessName: "Marie Conseil",
      fiat: { minor: 390410, digits: 2, currency: "CHF" },
      note: "Facture 2026-0042",
      onchainAddress: addresses[0],
      startsAt: world.now,
      endsAt: invoice.dueAt,
      redirectUrl: "https://marie-conseil.example/merci",
      owner: world.linkOwner,
      final: null
    });
    expect(sale.taker).toMatch(/^[0-9a-f]{32}$/);

    // The link's record: only the merchant's reading key opens the link's secret.
    const record = stored(
      world.keys.member.links.publicKey,
      linkRecordAddress(world.keys, invoice.sent.link.id)
    )!;
    const value = openRecord(record, {
      type: "team-link",
      encryptionKey: world.keys.member.records.encryptionKey,
      address: linkRecordAddress(world.keys, invoice.sent.link.id),
      author: world.keys.member.links.publicKey,
      parse: (v) => v as { sealedKey: string; onchainTag: string; link: string; createdAt: number }
    });
    const { sealedKey, onchainTag, createdAt } = (
      value as { value: { sealedKey: string; onchainTag: string; createdAt: number } }
    ).value;
    expect(onchainTag).toBe("0000000000000000");
    expect(createdAt).toBe(linkCopy.created_at);
    const secret = nip44Decrypt(
      sealedKey,
      conversationKey(world.readerSecret, invoice.sent.link.id)
    );
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    // A channel without the link key reader (an older merchant's app): sealed for the
    // registry reader, as before, without `sealedFor`.
    expect((value as { value: Record<string, unknown> }).value.sealedFor).toBeUndefined();

    // The invoice, at its address, and the counter's copy of the assistant.
    const invoiceCopy = stored(
      world.keys.invoices.nostr.publicKey,
      invoiceAddress(world.keys, invoice.id)
    )!;
    const opened = openRecord(invoiceCopy, {
      type: "invoice",
      encryptionKey: world.keys.invoices.encryptionKey,
      address: invoiceAddress(world.keys, invoice.id),
      author: world.keys.invoices.nostr.publicKey,
      parse: parseInvoice
    });
    expect((opened as { value: unknown }).value).toEqual(invoice);
    const shared = counterKeys(world.counterKey);
    const counter = stored(world.keys.invoices.nostr.publicKey, shared.address)!;
    expect(
      (
        openRecord(counter, {
          type: "invoice-counter-shared",
          encryptionKey: shared.encryptionKey,
          address: shared.address,
          author: world.keys.invoices.nostr.publicKey,
          parse: (v) => v
        }) as { value: unknown }
      ).value
    ).toEqual({ version: 1, year: 2026, last: 42 });

    // The address is used.
    const used = stored(world.keys.member.nostr.publicKey, usedAddress(world.keys))!;
    const usedValue = openRecord(used, {
      type: "team-onchain-used",
      encryptionKey: world.keys.member.records.encryptionKey,
      address: usedAddress(world.keys),
      author: world.keys.member.nostr.publicKey,
      parse: (v, event) => parseUsed(v, event.created_at)
    });
    expect((usedValue as { value: { used: string[] } }).value.used).toEqual([addresses[0]]);
  });

  it("seals the link's secret for the merchant's link key reader, never for a key a grant gives", async () => {
    // The export grant gives the registry reader's secret, never this one's.
    const linkKeyReaderSecret = new Uint8Array(32).fill(9);
    const linkKeyReader = bytesToHex(schnorr.getPublicKey(linkKeyReaderSecret));
    world.publishChannel(world.channelValue(world.now - 50, { linkKeyReader }), world.now - 50);
    const { invoice } = await make();
    const record = stored(
      world.keys.member.links.publicKey,
      linkRecordAddress(world.keys, invoice.sent.link.id)
    )!;
    const opened = openRecord(record, {
      type: "team-link",
      encryptionKey: world.keys.member.records.encryptionKey,
      address: linkRecordAddress(world.keys, invoice.sent.link.id),
      author: world.keys.member.links.publicKey,
      parse: (v) => v as { version: number; sealedKey: string; sealedFor?: string }
    });
    const { version, sealedKey, sealedFor } = (
      opened as { value: { version: number; sealedKey: string; sealedFor?: string } }
    ).value;
    // The record's format unchanged: the merchant's apps before it still read it.
    expect(version).toBe(1);
    expect(sealedFor).toBe("link-key-reader");
    const secret = nip44Decrypt(
      sealedKey,
      conversationKey(linkKeyReaderSecret, invoice.sent.link.id)
    );
    expect(bytesToHex(schnorr.getPublicKey(hexToBytes(secret)))).toBe(invoice.sent.link.id);
    // The registry reader (an export grant's) no longer opens it.
    expect(() =>
      nip44Decrypt(sealedKey, conversationKey(world.readerSecret, invoice.sent.link.id))
    ).toThrow();
  });

  it("gives the next numbers, and the next addresses, invoice after invoice", async () => {
    const first = await make();
    world.now += 5;
    const second = await make();
    expect([first.number, second.number]).toEqual(["2026-0042", "2026-0043"]);
    expect([first.onchainAddress, second.onchainAddress]).toEqual(addresses);
  });

  it("lists the invoices it made", async () => {
    const made = await make();
    const read = await withCall(world.services(), (call) =>
      readInvoices(call, world.keys, world.relays)
    );
    expect(read).toEqual({
      invoices: [made.invoice],
      complete: true,
      newer: false,
      hiddenAt: null
    });
  });

  it("skips an address something already paid", async () => {
    world.chain.add(addresses[0]!, payment(txid("old"), addresses[0]!, 5000, { height: 900_000 }));
    const made = await make();
    expect(made.onchainAddress).toBe(addresses[1]);
  });

  it("without an address, stays within Lightning's bounds", async () => {
    world.chain.down.add("mempool");
    const made = await make();
    expect(made.onchainAddress).toBeNull();
    // 3904.10 CHF at 80 000 CHF/BTC: 4 880 125 sats; the address takes 100 000 000 at most.
    world.pay = { ...world.pay, maxSendable: 6_000_000_000 };
    const refused = await failure(make());
    expect(refused.code).toBe("above_lightning");
    expect(refused.details).toEqual(["4800000"]);
  });

  it("says when the price or the Lightning address cannot be read, before taking a number", async () => {
    world.publishChannel(
      world.channelValue(world.now - 50, {
        profile: {
          businessName: "Marie Conseil",
          lightningAddress: "sattleme02c6047f94@breez.tips",
          currency: "CHF",
          onchain: false,
          logo: null
        }
      }),
      world.now - 50
    );
    world.coingeckoDown = true;
    const refused = await failure(make());
    expect(refused.code).toBe("unverified");
    world.coingeckoDown = false;
    const made = await make();
    // No number was lost.
    expect(made.number).toBe("2026-0042");
  });

  it.each([
    ["a blank recipient's name", { recipient: { ...request().recipient, name: " " } }, "recipient"],
    ["no line", { lines: [] }, "lines: at least one"],
    [
      "a line of no quantity",
      { lines: [{ name: "x", quantity: 0, unitMinor: 1, vatRate: 0 }] },
      "lines[0]"
    ],
    ["a due date today", { dueDate: "2026-11-03" }, "dueDate: from 2026-11-04 to 2027-08-03"],
    [
      "a due date in ten months",
      { dueDate: "2027-09-03" },
      "dueDate: from 2026-11-04 to 2027-08-03"
    ],
    [
      "an http redirection",
      { redirectUrl: "http://marie.example" },
      "redirectUrl: an https URL of at most 500 characters"
    ],
    ["an unknown time zone", { timeZone: "Mars/Olympus" }, "timeZone"]
  ])("refuses %s before taking anything", async (_, extra, problem) => {
    const before = world.net.get(world.relays[0]!).received.length;
    const refused = await failure(make(extra));
    expect(refused.code).toBe("invalid_invoice");
    expect(refused.details).toContain(problem);
    expect(world.net.get(world.relays[0]!).received.length).toBe(before);
  });

  it("stops at once when the merchant removed the assistant", async () => {
    world.publishChannel(
      { version: 1, status: "removed", updatedAt: world.now - 10 },
      world.now - 10
    );
    const refused = await failure(make());
    expect(refused.code).toBe("revoked");
    expect(world.net.get(world.relays[0]!).received).toEqual([]);
  });

  it("makes none without the merchant's web app", async () => {
    const value = world.channelValue(world.now - 10);
    world.publishChannel(
      { ...value, invoicing: { ...value.invoicing, linkOrigin: null } },
      world.now - 10
    );
    expect((await failure(make())).code).toBe("no_web_app");
  });

  it("takes no number when fewer than a majority of the relays take its counter", async () => {
    const refusing = {
      refuseEvent: (event: NostrEvent) =>
        event.pubkey === world.keys.invoices.nostr.publicKey ? "blocked" : undefined
    };
    world.net.get(world.relays[0]!).behaviour = refusing;
    world.net.get(world.relays[1]!).behaviour = refusing;
    expect((await failure(make())).code).toBe("number");
  });

  it("follows the channel to the account's new relays", async () => {
    await world.net.add("wss://relay-d.test");
    const moved = ["wss://relay-d.test"];
    world.publishChannel(world.channelValue(world.now - 10, { relays: moved }), world.now - 10);
    world.publishChannel(
      world.channelValue(world.now - 5, { relays: moved }),
      world.now - 5,
      moved
    );
    const made = await make();
    expect(made.invoice.sent.link.relays).toEqual(moved);
    // A new list: its counter starts there (the owner's copy is on the old relays).
    expect(made.number).toBe("2026-0001");
  });
});

describe("the lot of deposit addresses (SPEC.md §10)", () => {
  /** `count` addresses of the lot, distinct from the others of this file. */
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) => depositAddress(`many ${index}`));

  /** The used record this assistant wrote, as the merchant's app reads it. */
  function usedRecord() {
    const event = stored(world.keys.member.nostr.publicKey, usedAddress(world.keys))!;
    const opened = openRecord(event, {
      type: "team-onchain-used",
      encryptionKey: world.keys.member.records.encryptionKey,
      address: usedAddress(world.keys),
      author: world.keys.member.nostr.publicKey,
      parse: (v) => v
    });
    return (opened as { value: { version: number; used: string[] } }).value;
  }

  it("writes its used record in the version of a lot of version 1", async () => {
    await make();
    expect(usedRecord()).toMatchObject({ version: 1, used: [addresses[0]] });
  });

  it("takes from a lot of version 2 beyond 20 addresses, its used record of version 2", async () => {
    const lot = many(100);
    world.publishLot(lot, world.now - 60, { version: 2 });
    world.publishUsed(lot.slice(0, 25), world.now - 60, world.now - 30, 2);
    const made = await make();
    expect(made.onchainAddress).toBe(lot[25]);
    expect(usedRecord()).toMatchObject({ version: 2, used: lot.slice(0, 26) });
  });

  it("takes none from a lot of more addresses than its version holds", async () => {
    for (const [version, count] of [
      [1, 21],
      [2, 101]
    ] as const) {
      world.publishLot(many(count), world.now - 60 + version, { version });
      const made = await make();
      expect(made.onchainAddress).toBeNull();
      world.now += 5;
    }
  });

  it("takes none from a lot of a newer format, nor from an older copy a relay still holds", async () => {
    // The newer lot on one relay only: the others hold the lot of version 1 from before.
    world.publishLot(many(3), world.now - 60, { version: 3, relays: [world.relays[0]!] });
    const made = await make();
    expect(made.onchainAddress).toBeNull();
  });

  it("takes none, and writes nothing over, when its used record is of a newer format", async () => {
    const newer = world.publishUsed([addresses[0]!], world.now - 90, world.now - 30, 3);
    const made = await make();
    expect(made.onchainAddress).toBeNull();
    expect(stored(world.keys.member.nostr.publicKey, usedAddress(world.keys))).toEqual(newer);
  });
});
