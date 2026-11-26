import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { openRecord } from "../vendor/checkout-node/src/nostr/record.js";
import { invoiceTotals } from "../src/protocol/amounts.js";
import { INVOICE_TYPE } from "../src/protocol/constants.js";
import {
  encodeRelayList,
  InvalidAssistantKeyError,
  parseAssistantKey
} from "../src/protocol/key.js";
import {
  counterKeys,
  deriveAssistantKeys,
  invoiceAddress,
  lotAddress,
  usedAddress
} from "../src/protocol/keys.js";
import {
  formatInvoiceNumber,
  invoiceEvent,
  parseInvoice,
  type Invoice
} from "../src/protocol/invoice.js";

import { vectors } from "./helpers/vectors.js";

describe("the assistant key", () => {
  it("reads the app's key", () => {
    const key = parseAssistantKey(vectors.secretKey);
    expect(key.teamPublicKey).toBe(vectors.parsed.team);
    expect(bytesToHex(key.key)).toBe(vectors.parsed.assistantKey);
    expect(key.relays).toEqual(vectors.parsed.relays);
    expect(encodeRelayList(key.relays)).toBe(vectors.secretKey.split(".")[2]);
  });

  it("never shows the key when the object is printed", () => {
    const key = parseAssistantKey(vectors.secretKey);
    expect(JSON.stringify(key)).not.toContain(vectors.parsed.assistantKey);
    expect(Object.keys(key)).toEqual(["teamPublicKey", "relays"]);
  });

  it.each([
    ["an integration's key", vectors.secretKey.replace("sattleme_ak_", "sattleme_ck_")],
    ["a later format", vectors.secretKey.replace("sattleme_ak_", "sattleme_ak2_")],
    ["a key cut short", vectors.secretKey.split(".").slice(0, 2).join(".")],
    ["a part too many", `${vectors.secretKey}.cmVsYXkuZXhhbXBsZQ`],
    ["padding", vectors.secretKey.replace(/\.([^.]*)$/, ".$1=")],
    ["no relay", vectors.secretKey.replace(/\.[^.]*$/, ".")],
    [
      "a team key off the curve",
      `sattleme_ak_${"A".repeat(43)}.${vectors.secretKey.split(".").slice(1).join(".")}`
    ],
    ["not a text", 42]
  ])("refuses %s, without saying it", (_, text) => {
    let error: unknown;
    try {
      parseAssistantKey(text);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(InvalidAssistantKeyError);
    expect((error as Error).message).not.toContain(vectors.parsed.assistantKey);
  });
});

describe("the keys it gives", () => {
  const keys = deriveAssistantKeys(hexToBytes(vectors.parsed.assistantKey));
  const derived = vectors.derived;

  it("are the app's", () => {
    expect(keys.member.channel.address).toBe(derived.channelAddress);
    expect(bytesToHex(keys.member.channel.encryptionKey)).toBe(derived.channelEncryptionKey);
    expect(keys.member.nostr.publicKey).toBe(derived.memberPublicKey);
    expect(bytesToHex(keys.member.records.encryptionKey)).toBe(derived.recordsEncryptionKey);
    expect(bytesToHex(keys.member.records.addressKey)).toBe(derived.recordsAddressKey);
    expect(keys.member.links.publicKey).toBe(derived.linksPublicKey);
    expect(bytesToHex(keys.takerKey)).toBe(derived.takerKey);
    expect(keys.invoices.nostr.publicKey).toBe(derived.invoicesAuthor);
    expect(bytesToHex(keys.invoices.encryptionKey)).toBe(derived.invoicesEncryptionKey);
    expect(bytesToHex(keys.invoices.addressKey)).toBe(derived.invoicesAddressKey);
    expect(lotAddress(keys)).toBe(derived.lotAddress);
    expect(usedAddress(keys)).toBe(derived.usedAddress);
  });

  it("give the shared counter's keys", () => {
    const counter = counterKeys(hexToBytes(vectors.counter.counterKey));
    expect(bytesToHex(counter.encryptionKey)).toBe(vectors.counter.encryptionKey);
    expect(counter.address).toBe(vectors.counter.address);
  });
});

describe("an invoice", () => {
  const keys = deriveAssistantKeys(hexToBytes(vectors.parsed.assistantKey));
  const open = (event: unknown) =>
    openRecord(event, {
      type: INVOICE_TYPE,
      encryptionKey: keys.invoices.encryptionKey,
      address: vectors.invoice.address,
      author: keys.invoices.nostr.publicKey,
      parse: (value) => parseInvoice(value)
    });

  it("opens as the app wrote it, with its totals", () => {
    const opened = open(vectors.invoice.event);
    expect(opened?.status).toBe("ok");
    const invoice = (opened as { value: Invoice }).value;
    expect(invoice).toEqual(vectors.invoice.value);
    expect(invoiceAddress(keys, invoice.id)).toBe(vectors.invoice.address);
    expect(invoiceTotals(invoice.lines, invoice.currency.digits)).toEqual(vectors.invoice.totals);
    expect(formatInvoiceNumber(invoice.number)).toBe("2026-0042");
  });

  it("is made again to the same value, padded to 1024 bytes", () => {
    const invoice = vectors.invoice.value as Invoice;
    const event = invoiceEvent(keys, invoice);
    expect(event.tags).toEqual([["d", vectors.invoice.address]]);
    expect(event.created_at).toBe(invoice.updatedAt);
    expect((open(event) as { value: Invoice }).value).toEqual(invoice);
    // NIP-44: base64 of version, nonce, ciphertext (the padded text, NIP-44 padded), MAC.
    const bytes = Buffer.from(event.content, "base64").length - 1 - 32 - 32 - 2;
    expect(bytes % 1024).toBe(0);
  });

  it.each([
    ["a draft", { status: "draft" }],
    ["no line", { lines: [] }],
    ["a blank line name", { lines: [{ name: " ", quantity: 100, unitMinor: 1, vatRate: 0 }] }],
    ["a total of zero", { lines: [{ name: "x", quantity: 100, unitMinor: 0, vatRate: 0 }] }],
    ["a due end before it was sent", { dueAt: 1793000100 }],
    ["an http redirect", { redirectUrl: "http://marie-conseil.example/merci" }],
    [
      "a blank recipient",
      {
        recipient: {
          name: "",
          street: "a",
          postalCode: "1",
          city: "c",
          country: "CH",
          reference: ""
        }
      }
    ]
  ])("is not one with %s", (_, change) => {
    expect(parseInvoice({ ...(vectors.invoice.value as object), ...change })).toBeNull();
  });

  it("of a newer version is told so", () => {
    expect(() => parseInvoice({ ...(vectors.invoice.value as object), version: 2 })).toThrow();
  });
});
