import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { publicKeyOf } from "../vendor/checkout-node/src/nostr/event.js";
import { conversationKey, nip44Decrypt } from "../vendor/checkout-node/src/nostr/nip44.js";
import { openRecord } from "../vendor/checkout-node/src/nostr/record.js";
import { fakeFetch, answer } from "../vendor/checkout-node/test/helpers/fetch.js";
import { RelayNet } from "../vendor/checkout-node/test/helpers/relay.js";

import { invoicingOf, readChannel } from "../src/protocol/channel.js";
import { withCall, type Services } from "../src/protocol/context.js";
import { takeNumber } from "../src/protocol/counter.js";
import { parseAssistantKey } from "../src/protocol/key.js";
import { deriveAssistantKeys, linkRecordAddress } from "../src/protocol/keys.js";
import {
  assistantTakerTag,
  linkAddress,
  linkEvent,
  linkRecordEvent,
  linkSale,
  linkUrl,
  parseLinkPayload,
  type LinkPayload,
  type LinkRecord
} from "../src/protocol/link.js";
import { takeAddress } from "../src/protocol/lot.js";

import { NO_INVOICING_PATH, noInvoicingVectors, vectors } from "./helpers/vectors.js";

/*
 * The app's vectors (vectors/app/assistant.json, SPEC.md §19) read and made again as this server
 * reads and makes them, on a local relay named as the vectors' key names it. The app's test suite
 * reads the same file (its src/__tests__/assistant-vectors.test.ts): a change on either side breaks
 * one of them.
 */

const RELAY = vectors.parsed.relays[0]!;
const access = parseAssistantKey(vectors.secretKey);
const keys = deriveAssistantKeys(access.key);
let net: RelayNet;

function services(now: number): Services {
  const chain = fakeFetch((url) =>
    url.pathname.endsWith("/blocks/tip/height") ? { text: "970000" } : answer([])
  );
  return {
    createSocket: (url: string) => new net.WebSocket(url),
    fetch: chain.fetch,
    timeoutMs: 2000,
    now: () => now
  };
}

beforeEach(async () => {
  net = new RelayNet();
  const relay = await net.add(RELAY);
  for (const event of [
    vectors.channel.event,
    vectors.lot.event,
    vectors.used.event,
    vectors.counter.ownerCopy.event,
    vectors.link.event,
    vectors.linkRecord.event
  ]) {
    relay.take(event);
  }
});

afterEach(async () => {
  await net.close();
});

describe("the app's vectors of an assistant without invoices", () => {
  it("are the app's src/__tests__/fixtures/mcp-server/assistant-no-invoicing.json", () => {
    // Its test suite pins the same SHA-256 (src/__tests__/assistant-vectors.test.ts).
    const sha = createHash("sha256").update(readFileSync(NO_INVOICING_PATH)).digest("hex");
    expect(sha).toBe("6b9b3d06e07305c0323d8348f47d9c1b35755e2c925e73c2dd95031979bd4f1d");
  });

  it("give a channel without invoicing: no invoice is made nor read", async () => {
    net.get(RELAY).take(noInvoicingVectors.channel.event);
    const at = noInvoicingVectors.channel.value.updatedAt + 1;
    const channel = await withCall(services(at), (call) => readChannel(call, access, keys));
    const value = vectors.channel.value;
    expect(channel).toMatchObject({
      name: "Carol's assistant",
      businessName: value.profile.businessName,
      registryKey: value.registryKey,
      relays: value.relays,
      invoicing: null,
      updatedAt: noInvoicingVectors.channel.value.updatedAt
    });
    expect(() => invoicingOf(channel)).toThrow(
      expect.objectContaining({ code: "invoicing_not_allowed" })
    );
  });
});

describe("the app's vectors", () => {
  it("give the channel the owner wrote", async () => {
    const channel = await withCall(services(vectors.channel.value.updatedAt + 1), (call) =>
      readChannel(call, access, keys)
    );
    const value = vectors.channel.value;
    expect(channel).toMatchObject({
      name: "Carol's assistant",
      businessName: value.profile.businessName,
      lightningAddress: value.profile.lightningAddress,
      currency: "CHF",
      onchain: true,
      registryKey: value.registryKey,
      registryReader: value.registryReader,
      linkOwner: value.linkOwner,
      relays: value.relays,
      tolerance: 0,
      bitcoinNode: null,
      invoicing: value.invoicing,
      updatedAt: value.updatedAt
    });
  });

  it("give the next number after the owner's copy of the counter", async () => {
    const number = await withCall(
      services(vectors.counter.ownerCopy.event.created_at + 1),
      (call) =>
        takeNumber(
          call,
          keys,
          {
            counterKey: vectors.counter.counterKey,
            writers: vectors.channel.value.invoicing.counterWriters,
            relays: vectors.parsed.relays
          },
          vectors.counter.ownerCopy.value.year
        )
    );
    expect(number).toEqual(vectors.counter.next);
  });

  it("give the lot's address not used yet", async () => {
    const taken = await withCall(services(vectors.used.value.updatedAt + 1), async (call) => {
      const channel = await readChannel(call, access, keys);
      return takeAddress(call, access, keys, channel);
    });
    expect(taken).toEqual({
      address: vectors.lot.value.addresses[1],
      tag: vectors.lot.value.tags[1]
    });
  });

  it("give the address of a lot of version 2 its used record leaves, beyond 20", async () => {
    const relay = net.get(RELAY);
    relay.take(vectors.lotV2.event);
    relay.take(vectors.usedV2.event);
    const used = vectors.usedV2.value.used.length;
    expect(vectors.lotV2.value.addresses).toHaveLength(100);
    expect(used).toBeGreaterThan(20);
    const taken = await withCall(services(vectors.usedV2.value.updatedAt + 1), async (call) => {
      const channel = await readChannel(call, access, keys);
      return takeAddress(call, access, keys, channel);
    });
    expect(taken).toEqual({
      address: vectors.lotV2.value.addresses[used],
      tag: vectors.lotV2.value.tags[used]
    });
  });

  it("hold a link and its record this server makes alike", () => {
    const saleKey = hexToBytes(vectors.link.saleKey);
    const secret = hexToBytes(vectors.link.linkSecretKey);
    expect(publicKeyOf(secret)).toBe(vectors.link.author);
    const sale = linkSale(saleKey, vectors.channel.value, "");
    expect(sale.author).toBe(vectors.link.saleAuthor);
    expect(assistantTakerTag(keys, sale.author)).toBe(vectors.link.takerTag);
    expect(linkAddress(saleKey)).toBe(vectors.link.address);
    expect(
      linkUrl("https://pay.example", vectors.link.author, saleKey, vectors.parsed.relays)
    ).toBe(vectors.link.url);
    const payload = vectors.link.payload as LinkPayload;
    const open = (event: unknown) =>
      openRecord(event, {
        type: "payment-link",
        encryptionKey: saleKey,
        address: vectors.link.address,
        author: vectors.link.author,
        parse: (value) => value
      });
    expect((open(vectors.link.event) as { value: unknown }).value).toEqual(payload);
    expect(parseLinkPayload(payload)).not.toBeNull();
    const made = linkEvent(secret, saleKey, payload, (n) => new Uint8Array(n).fill(9));
    expect(made.created_at).toBe(vectors.link.event.created_at);
    expect((open(made) as { value: unknown }).value).toEqual(payload);

    // The record: its sealed key opens with the merchant's reading key only (not in the vectors:
    // the conversation is the same from the link's side).
    const record = vectors.linkRecord.value as LinkRecord;
    expect(linkRecordAddress(keys, record.link)).toBe(vectors.linkRecord.address);
    const sealed = nip44Decrypt(
      record.sealedKey,
      conversationKey(secret, vectors.channel.value.registryReader)
    );
    expect(sealed).toBe(bytesToHex(secret));
    const again = linkRecordEvent(keys, record, (n) => new Uint8Array(n).fill(9));
    expect(
      (
        openRecord(again, {
          type: "team-link",
          encryptionKey: keys.member.records.encryptionKey,
          address: vectors.linkRecord.address,
          author: keys.member.links.publicKey,
          parse: (value) => value
        }) as { value: unknown }
      ).value
    ).toEqual(record);
  });
});
