import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NostrEvent } from "../vendor/checkout-node/src/nostr/event.js";
import { RelayNet } from "../vendor/checkout-node/test/helpers/relay.js";

import { decisionAddress, readExportGrant } from "../src/export/grant.js";
import { withCall, type Services } from "../src/protocol/context.js";
import { parseAssistantKey } from "../src/protocol/key.js";
import { deriveAssistantKeys } from "../src/protocol/keys.js";
import { sealRecordIn } from "../src/protocol/record.js";

import { vectors as assistant } from "./helpers/vectors.js";

/*
 * The merchant's grant of the export (SPEC.md §20), as the app writes it: the grant of the app's
 * vectors (vectors/app/export.json, `grant`, for the assistant of vectors/app/assistant.json) read
 * with the assistant's key alone gives exactly the keys it holds; withdrawn, of a newer format, or
 * read by too few relays, it gives nothing.
 */

const exportVectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "vectors", "app", "export.json"), "utf8")
) as {
  grant: {
    team: string;
    events: NostrEvent[];
    keys: unknown;
    later: Record<"withdrawn" | "allowedAgain" | "newer", NostrEvent>;
  };
};

const RELAYS = ["wss://relay.example", "wss://relay-b.example", "wss://relay-c.example"];
const access = parseAssistantKey(assistant.secretKey);
const keys = deriveAssistantKeys(access.key);
const NOW = 1_793_100_000;
let net: RelayNet;

function services(): Services {
  return {
    createSocket: (url: string) => new net.WebSocket(url),
    fetch: () => Promise.reject(new Error("no HTTP here")),
    timeoutMs: 2000,
    now: () => NOW
  };
}

const read = () => withCall(services(), (call) => readExportGrant(call, access, keys, RELAYS));

/** The relays, each holding `events`; those of `down` refuse connections. */
async function relaysHolding(events: readonly NostrEvent[], down: readonly string[] = []) {
  for (const url of RELAYS) {
    if (down.includes(url)) {
      net.down.add(url);
      continue;
    }
    const relay = await net.add(url);
    for (const event of events) relay.take(event);
  }
}

beforeEach(() => {
  net = new RelayNet();
});

afterEach(async () => {
  await net.close();
});

describe("the merchant's grant of the export", () => {
  it("is the team's of the assistant's key", () => {
    expect(exportVectors.grant.team).toBe(access.teamPublicKey);
    expect(exportVectors.grant.team).toBe(assistant.parsed.team);
  });

  it("gives, read with the assistant's key alone, the keys the app wrote", async () => {
    await relaysHolding(exportVectors.grant.events);
    expect(await read()).toEqual(exportVectors.grant.keys);
  });

  it("gives nothing without a majority of the relays", async () => {
    await relaysHolding(exportVectors.grant.events, RELAYS.slice(1));
    await expect(read()).rejects.toMatchObject({ code: "network" });
  });

  it("gives nothing without a decision, nor with the keys of another decision", async () => {
    const [, ...parts] = exportVectors.grant.events;
    await relaysHolding(parts);
    await expect(read()).rejects.toMatchObject({ code: "export_not_allowed" });
  });
});

describe("a grant the merchant withdrew or a newer app wrote", () => {
  const { later, events } = exportVectors.grant;

  it("gives nothing once withdrawn, whatever its keys still say", async () => {
    await relaysHolding([...events, later.withdrawn]);
    await expect(read()).rejects.toMatchObject({ code: "export_not_allowed" });
  });

  it("gives nothing when allowed again until the keys of that decision are written", async () => {
    await relaysHolding([...events, later.allowedAgain]);
    await expect(read()).rejects.toMatchObject({ code: "export_unread" });
  });

  it("is never read past a decision of a newer format", async () => {
    await relaysHolding([...events, later.newer]);
    await expect(read()).rejects.toMatchObject({ code: "newer" });
  });

  it("is never another author's", async () => {
    // A decision withdrawing it, sealed with the assistant's key but signed by someone else.
    const stranger = sealRecordIn({
      type: "assistant-export",
      value: { version: 1, allowed: false, updatedAt: NOW },
      signer: new Uint8Array(32).fill(9),
      encryptionKey: keys.exportGrant.encryptionKey,
      address: decisionAddress(keys),
      createdAt: NOW,
      block: 256
    });
    await relaysHolding([...events, stranger]);
    expect(await read()).toEqual(exportVectors.grant.keys);
  });
});
