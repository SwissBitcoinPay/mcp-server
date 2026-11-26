/**
 * A merchant for tests, as the app would set it up: a team, an integration's key, the channel the
 * team publishes on local relays, the registry, and a Lightning address (breez.tips) answered by a
 * fake fetch that makes real-looking invoices.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import { channelKeys, lotAddress } from "../../src/derive.js";
import { bytesToBase64Url } from "../../src/encoding.js";
import { MEMPOOL_WEBSOCKET_URL, INTEGRATION_KEY_PREFIX } from "../../src/protocol.js";
import { sealRecord } from "../../src/nostr/record.js";
import type { NostrEvent } from "../../src/nostr/event.js";

import { FakeChain, FakeExplorerSocket } from "./chain.js";
import { answer, fakeFetch, type JsonAnswer } from "./fetch.js";
import { makeInvoice, metadataHash, preimagePair } from "./lightning.js";
import { RelayNet, type RelayBehaviour } from "./relay.js";

export const LIGHTNING_ADDRESS = "sattleme02c6047f94@breez.tips";
export const METADATA = JSON.stringify([
  ["text/identifier", LIGHTNING_ADDRESS],
  ["text/plain", "Pay to Sunrise Bakery"]
]);
export const PAY_URL = "https://breez.tips/.well-known/lnurlp/sattleme02c6047f94";
export const CALLBACK = "https://breez.tips/lnurlp/sattleme02c6047f94/invoice";

/** Fixed bytes: tests are reproducible. */
export function bytes(seed: number, length = 32): Uint8Array {
  return new Uint8Array(length).fill(seed);
}

/** The text of an integration key, as the merchant's app writes it. */
export function formatKey(team: string, key: Uint8Array, relays: readonly string[]): string {
  const hosts = relays.map((relay) => relay.slice("wss://".length)).join(",");
  return (
    INTEGRATION_KEY_PREFIX +
    [
      bytesToBase64Url(hexToBytes(team)),
      bytesToBase64Url(key),
      bytesToBase64Url(utf8ToBytes(hosts))
    ].join(".")
  );
}

/** An invoice the fake breez.tips made, with what pays it. */
export type MadeInvoice = {
  pr: string;
  verify: string;
  paymentHash: string;
  preimage: string;
  amountMsat: bigint;
  expiry: number;
  comment: string | null;
};

export type MerchantOptions = {
  /** The relays of the key. */
  keyRelays?: string[];
  /** The account's relays the channel names (none: it names no list). */
  accountRelays?: string[];
  behaviours?: Record<string, RelayBehaviour>;
  /** Unix seconds: the clock of the test. */
  now?: number;
};

export class TestMerchant {
  readonly net = new RelayNet();
  readonly teamSecret = bytes(1);
  readonly team = bytesToHex(schnorr.getPublicKey(this.teamSecret));
  readonly integrationKey = bytes(2);
  readonly registryKey = bytes(3);
  readonly readerSecret = bytes(4);
  readonly reader = bytesToHex(schnorr.getPublicKey(this.readerSecret));
  keyRelays: string[] = ["wss://relay-a.test", "wss://relay-b.test", "wss://relay-c.test"];
  /** Unix seconds. */
  now = 1_791_378_000;
  /** The invoices breez.tips made, by payment hash. */
  readonly invoices = new Map<string, MadeInvoice>();
  /** Payment hashes paid. */
  readonly paid = new Set<string>();
  /** What breez.tips's pay request says. */
  pay = {
    tag: "payRequest",
    callback: CALLBACK,
    minSendable: 1000,
    maxSendable: 100_000_000_000,
    metadata: METADATA,
    commentAllowed: 255
  } as Record<string, unknown>;
  /** Changes the invoice breez.tips gives (a test of a check). */
  tamper: ((invoice: MadeInvoice) => Partial<MadeInvoice>) | null = null;
  /** The explorers and BlockCypher. */
  readonly chain = new FakeChain();
  /** Overrides the answer of a URL. */
  override: ((url: URL) => JsonAnswer | undefined) | null = null;
  private seed = 10;
  readonly http = fakeFetch((url) => this.route(url));

  get key(): string {
    return formatKey(this.team, this.integrationKey, this.keyRelays);
  }

  /** Starts the key's relays (and `others`). */
  async start(others: string[] = [], behaviours: Record<string, RelayBehaviour> = {}) {
    for (const url of new Set([...this.keyRelays, ...others])) {
      await this.net.add(url, behaviours[url] ?? {});
    }
    return this;
  }

  async stop() {
    await this.net.close();
  }

  /** The channel's value, active, as the merchant's app writes it. */
  channelValue(createdAt: number, extra: Record<string, unknown> = {}) {
    return {
      version: 1,
      status: "active",
      name: "Shopify store",
      role: "integration",
      profile: {
        businessName: "Sunrise Bakery",
        lightningAddress: LIGHTNING_ADDRESS,
        currency: "CHF",
        onchain: true,
        logo: null
      },
      registryKey: bytesToHex(this.registryKey),
      registryReader: this.reader,
      linkOwner: "ab".repeat(32),
      updatedAt: createdAt,
      ...extra
    };
  }

  /** The channel's event, signed by `signer` (the team by default). */
  channelEvent(value: unknown, createdAt: number, signer = this.teamSecret): NostrEvent {
    const keys = channelKeys(this.integrationKey);
    return sealRecord({
      type: "team-channel",
      value,
      signer,
      encryptionKey: keys.encryptionKey,
      address: keys.address,
      createdAt
    });
  }

  /** Publishes the channel on `relays` (the key's by default). */
  publishChannel(value: unknown, createdAt: number, relays = this.keyRelays, signer?: Uint8Array) {
    const event = this.channelEvent(value, createdAt, signer);
    for (const relay of relays) this.net.get(relay).store(event);
    return event;
  }

  /** Publishes the integration's lot of deposit addresses on `relays`, as the merchant's app does. */
  publishLot(addresses: string[], createdAt: number, relays = this.keyRelays) {
    const event = sealRecord({
      type: "integration-onchain-lot",
      value: { version: 1, addresses, updatedAt: createdAt },
      signer: this.teamSecret,
      encryptionKey: channelKeys(this.integrationKey).encryptionKey,
      address: lotAddress(this.integrationKey),
      createdAt
    });
    for (const relay of relays) this.net.get(relay).store(event);
    return event;
  }

  /** Starts the explorer's WebSocket (wss://mempool.space/api/v1/ws). */
  async startExplorerSocket(): Promise<FakeExplorerSocket> {
    return new FakeExplorerSocket(await this.net.addServer(MEMPOOL_WEBSOCKET_URL));
  }

  /** Marks an invoice paid on breez.tips. */
  payInvoice(paymentHash: string) {
    this.paid.add(paymentHash);
  }

  private route(url: URL): JsonAnswer {
    const overridden = this.override?.(url);
    if (overridden) return overridden;
    const onchain = this.chain.route(url);
    if (onchain) return onchain;
    if (url.href === PAY_URL) return answer(this.pay);
    if (url.origin + url.pathname === CALLBACK) {
      const amount = BigInt(url.searchParams.get("amount")!);
      const expiry = Number(url.searchParams.get("expiry") ?? 3600);
      const { preimage, paymentHash } = preimagePair(this.seed++);
      let made: MadeInvoice = {
        pr: makeInvoice({
          amountMsat: amount,
          paymentHash,
          descriptionHash: metadataHash(METADATA),
          timestamp: this.now,
          expirySeconds: expiry
        }),
        verify: `https://breez.tips/lnurlp/verify/${paymentHash}`,
        paymentHash,
        preimage,
        amountMsat: amount,
        expiry,
        comment: url.searchParams.get("comment")
      };
      if (this.tamper) made = { ...made, ...this.tamper(made) };
      this.invoices.set(made.paymentHash, made);
      return answer({ pr: made.pr, verify: made.verify, routes: [] });
    }
    if (url.href.startsWith("https://breez.tips/lnurlp/verify/")) {
      const hash = url.pathname.split("/").at(-1)!;
      const made = this.invoices.get(hash);
      if (!made) return answer({ status: "ERROR", reason: "Not found" });
      const settled = this.paid.has(hash);
      return answer({
        status: "OK",
        settled,
        preimage: settled ? made.preimage : null,
        pr: made.pr
      });
    }
    throw new TypeError(`fetch failed: ${url.href}`);
  }
}
