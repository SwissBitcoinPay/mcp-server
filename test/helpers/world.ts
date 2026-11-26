import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import { bytesToBase64Url } from "../../vendor/checkout-node/src/encoding.js";
import type { NostrEvent } from "../../vendor/checkout-node/src/nostr/event.js";
import { sealRecord } from "../../vendor/checkout-node/src/nostr/record.js";
import { FakeChain } from "../../vendor/checkout-node/test/helpers/chain.js";
import {
  answer,
  fakeFetch,
  type JsonAnswer
} from "../../vendor/checkout-node/test/helpers/fetch.js";
import { makeInvoice, preimagePair } from "../../vendor/checkout-node/test/helpers/lightning.js";
import { RelayNet, type RelayBehaviour } from "../../vendor/checkout-node/test/helpers/relay.js";

import type { Services } from "../../src/protocol/context.js";
import { parseAssistantKey } from "../../src/protocol/key.js";
import {
  counterKeys,
  deriveAssistantKeys,
  lotAddress,
  usedAddress
} from "../../src/protocol/keys.js";

/*
 * A merchant for the assistant's tests, as the merchant's app sets it up: a team, an assistant key,
 * the channel and the lot the team publishes on local relays, other writers' copies of the counter,
 * and the services the assistant asks (breez.tips, CoinGecko, mempool.space, BlockCypher) answered
 * by a fake fetch. Never the network.
 */

export const LIGHTNING_ADDRESS = "sattleme02c6047f94@breez.tips";
export const METADATA = JSON.stringify([
  ["text/identifier", LIGHTNING_ADDRESS],
  ["text/plain", "Pay to Marie Conseil"]
]);
export const PAY_URL = "https://breez.tips/.well-known/lnurlp/sattleme02c6047f94";
export const CALLBACK = "https://breez.tips/lnurlp/sattleme02c6047f94/invoice";

export function bytes(seed: number, length = 32): Uint8Array {
  return new Uint8Array(length).fill(seed);
}

export function metadataHash(metadata: string): string {
  return bytesToHex(sha256(utf8ToBytes(metadata)));
}

/** A Lightning invoice breez.tips made for a sale, with what pays it. */
export type BreezInvoice = {
  pr: string;
  verify: string;
  paymentHash: string;
  preimage: string;
  sats: bigint;
  timestamp: number;
  expiry: number;
};

export class World {
  readonly net = new RelayNet();
  readonly chain = new FakeChain();
  readonly teamSecret = bytes(1);
  readonly team = bytesToHex(schnorr.getPublicKey(this.teamSecret));
  readonly assistantKey = bytes(2);
  readonly keys = deriveAssistantKeys(this.assistantKey);
  readonly registryKey = bytes(3);
  readonly readerSecret = bytes(4);
  readonly reader = bytesToHex(schnorr.getPublicKey(this.readerSecret));
  readonly ownerLinkSecret = bytes(5);
  readonly linkOwner = bytesToHex(schnorr.getPublicKey(this.ownerLinkSecret));
  readonly counterKey = bytes(6);
  /** The owner's invoices author (another writer of numbers). */
  readonly ownerInvoicesSecret = bytes(7);
  readonly ownerInvoices = bytesToHex(schnorr.getPublicKey(this.ownerInvoicesSecret));
  relays = ["wss://relay-a.test", "wss://relay-b.test", "wss://relay-c.test"];
  /** Unix seconds: the test's clock (03.11.2026 10:20 UTC). */
  now = 1_793_701_200;
  pay: Record<string, unknown> = {
    tag: "payRequest",
    callback: CALLBACK,
    minSendable: 1000,
    maxSendable: 100_000_000_000,
    metadata: METADATA,
    commentAllowed: 255
  };
  /** CoinGecko's hourly points, by currency then hour (Unix seconds). */
  readonly points = new Map<string, Map<number, number>>();
  coingeckoDown = false;
  /** mempool.space's first sight of transactions in its mempool (Unix seconds). */
  readonly firstSeen = new Map<string, number>();
  /** mempool.space's history of replacements: what each transaction replaced. */
  readonly rbf = new Map<string, string[]>();
  /** BlockCypher's details of replaced transactions. */
  readonly blockcypher = new Map<
    string,
    {
      received: string;
      inputs: { prev_hash: string; output_index: number }[];
      outputs: { value: number; addresses: string[] }[];
    }
  >();
  /** breez.tips's invoices, by payment hash; those paid. */
  readonly invoices = new Map<string, BreezInvoice>();
  readonly paid = new Set<string>();
  override: ((url: URL) => JsonAnswer | undefined) | null = null;
  readonly http = fakeFetch((url) => this.route(url));
  private seed = 40;

  get keyText(): string {
    const hosts = this.relays.map((relay) => relay.slice("wss://".length)).join(",");
    return `sattleme_ak_${bytesToBase64Url(hexToBytes(this.team))}.${bytesToBase64Url(
      this.assistantKey
    )}.${bytesToBase64Url(utf8ToBytes(hosts))}`;
  }

  get access() {
    return parseAssistantKey(this.keyText);
  }

  async start(behaviours: Record<string, RelayBehaviour> = {}) {
    for (const relay of this.relays) await this.net.add(relay, behaviours[relay] ?? {});
    return this;
  }

  async stop() {
    await this.net.close();
  }

  services(): Services {
    const net = this.net;
    return {
      createSocket: (url: string) => new net.WebSocket(url),
      fetch: this.http.fetch,
      timeoutMs: 2000,
      now: () => this.now
    };
  }

  /** Stores `event` on `relays` (all by default), as relays keep it. */
  store(event: NostrEvent, relays = this.relays) {
    for (const relay of relays) this.net.get(relay).take(event);
  }

  channelValue(createdAt: number, extra: Record<string, unknown> = {}) {
    return {
      version: 1,
      status: "active",
      name: "Claude de Marie",
      role: "assistant",
      profile: {
        businessName: "Marie Conseil",
        lightningAddress: LIGHTNING_ADDRESS,
        currency: "CHF",
        onchain: true,
        logo: null
      },
      registryKey: bytesToHex(this.registryKey),
      registryReader: this.reader,
      linkOwner: this.linkOwner,
      relays: this.relays,
      invoicing: {
        businessAddress: {
          street: "Rue du Lac 4",
          postalCode: "1003",
          city: "Lausanne",
          country: "CH"
        },
        companyNumber: "CHE-123.456.789",
        vatNumber: "CHE-123.456.789 TVA",
        detectedCountry: "CH",
        vatRate: 810,
        linkOrigin: "https://pay.example",
        counterKey: bytesToHex(this.counterKey),
        counterWriters: [this.ownerInvoices]
      },
      updatedAt: createdAt,
      ...extra
    };
  }

  publishChannel(value: unknown, createdAt: number, relays = this.relays) {
    const event = sealRecord({
      type: "team-channel",
      value,
      signer: this.teamSecret,
      encryptionKey: this.keys.member.channel.encryptionKey,
      address: this.keys.member.channel.address,
      createdAt
    });
    this.store(event, relays);
    return event;
  }

  publishLot(
    addresses: string[],
    createdAt: number,
    {
      tags,
      version = 1,
      relays = this.relays
    }: { tags?: string[]; version?: number; relays?: string[] } = {}
  ) {
    const event = sealRecord({
      type: "team-onchain-lot",
      value: {
        version,
        addresses,
        tags: tags ?? addresses.map((_, index) => index.toString(16).padStart(16, "0")),
        updatedAt: createdAt
      },
      signer: this.teamSecret,
      encryptionKey: this.keys.member.channel.encryptionKey,
      address: lotAddress(this.keys),
      createdAt
    });
    this.store(event, relays);
    return event;
  }

  /** The assistant's used record (SPEC.md §10), as an earlier call of it wrote it. */
  publishUsed(used: string[], lotAt: number, createdAt: number, version = 1) {
    const event = sealRecord({
      type: "team-onchain-used",
      value: { version, used, lotAt, updatedAt: createdAt },
      signer: this.keys.member.nostr.secretKey,
      encryptionKey: this.keys.member.records.encryptionKey,
      address: usedAddress(this.keys),
      createdAt
    });
    this.store(event);
    return event;
  }

  /** The owner's copy of the shared counter. */
  publishOwnerCounter(year: number, last: number, createdAt: number) {
    const shared = counterKeys(this.counterKey);
    const event = sealRecord({
      type: "invoice-counter-shared",
      value: { version: 1, year, last },
      signer: this.ownerInvoicesSecret,
      encryptionKey: shared.encryptionKey,
      address: shared.address,
      createdAt
    });
    this.store(event);
    return event;
  }

  /** Sets CoinGecko's point of `hour` in `currency`. */
  setPoint(currency: string, hour: number, price: number) {
    const book = this.points.get(currency) ?? new Map<number, number>();
    book.set(hour, price);
    this.points.set(currency, book);
  }

  /** Every hour from `from` to `to` at `price`. */
  setPoints(currency: string, from: number, to: number, price: number) {
    for (let hour = from; hour <= to; hour += 3600) this.setPoint(currency, hour, price);
  }

  /** An invoice breez.tips makes for `sats`, at `timestamp`, lasting `expiry` seconds. */
  breezInvoice(
    sats: bigint,
    timestamp: number,
    expiry: number,
    descriptionHash = metadataHash(METADATA)
  ) {
    const { preimage, paymentHash } = preimagePair(this.seed++);
    const made: BreezInvoice = {
      pr: makeInvoice({
        amountMsat: sats * 1000n,
        paymentHash,
        descriptionHash,
        timestamp,
        expirySeconds: expiry
      }),
      verify: `https://breez.tips/lnurlp/verify/${paymentHash}`,
      paymentHash,
      preimage,
      sats,
      timestamp,
      expiry
    };
    this.invoices.set(paymentHash, made);
    return made;
  }

  private route(url: URL): JsonAnswer {
    const overridden = this.override?.(url);
    if (overridden) return overridden;
    const href = url.href;
    if (href.startsWith("https://mempool.space/api/v1/transaction-times")) {
      const txid = url.searchParams.get("txId[]") ?? "";
      return answer([this.firstSeen.get(txid) ?? 0]);
    }
    const rbf = /^https:\/\/mempool\.space\/api\/v1\/tx\/([0-9a-f]{64})\/rbf$/.exec(href);
    if (rbf) {
      const replaced = this.rbf.get(rbf[1]!);
      return answer(
        replaced
          ? { replacements: null, replaces: replaced }
          : { replacements: null, replaces: null }
      );
    }
    if (
      href.startsWith("https://api.blockcypher.com/") &&
      url.searchParams.get("limit") === "100"
    ) {
      const id = url.pathname.split("/").at(-1)!;
      const kept = this.blockcypher.get(id);
      return kept ? answer({ hash: id, ...kept }) : answer({ error: "not found" }, 404);
    }
    const onchain = this.chain.route(url);
    if (onchain) return onchain;
    if (href === PAY_URL) return answer(this.pay);
    const verify = /^https:\/\/breez\.tips\/lnurlp\/verify\/([0-9a-f]{64})$/.exec(href);
    if (verify) {
      const made = this.invoices.get(verify[1]!);
      if (!made) return answer({ status: "ERROR", reason: "Not found" });
      const paid = this.paid.has(made.paymentHash);
      return answer({
        status: "OK",
        settled: paid,
        preimage: paid ? made.preimage : null,
        pr: made.pr
      });
    }
    if (href.startsWith("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart")) {
      if (this.coingeckoDown) return { status: 429, text: "Too many requests" };
      const currency = (url.searchParams.get("vs_currency") ?? "").toUpperCase();
      const book = this.points.get(currency) ?? new Map<number, number>();
      let from: number;
      let to: number;
      const fiveMinute = url.pathname.endsWith("/market_chart");
      if (fiveMinute) {
        from = this.now - 86_400;
        to = this.now;
      } else {
        from = Number(url.searchParams.get("from"));
        to = Number(url.searchParams.get("to"));
      }
      const prices: [number, number][] = [...book.entries()]
        .filter(([hour]) => hour >= from && hour <= to && hour <= this.now)
        .sort(([a], [b]) => a - b)
        .map(([hour, price]) => [hour * 1000, price]);
      // The 5-minute series ends with the live price.
      if (fiveMinute) prices.push([this.now * 1000 - 1234, 99_999.99]);
      return answer({ prices, market_caps: [], total_volumes: [] });
    }
    return { status: 404, text: `No route for ${url.host}` };
  }
}
