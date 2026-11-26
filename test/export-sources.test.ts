import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NostrEvent } from "../vendor/checkout-node/src/nostr/event.js";
import { RelayNet } from "../vendor/checkout-node/test/helpers/relay.js";

import type { ExportKeys } from "../src/export/grant.js";
import type { Line } from "../src/export/lines.js";
import { monthsOf, readHistoryLines } from "../src/export/sources/history.js";
import { readSendLines } from "../src/export/sources/sends.js";
import { readTillLines, tillSeatsOf } from "../src/export/sources/till.js";
import { FakeChain, payment } from "../vendor/checkout-node/test/helpers/chain.js";
import { fakeFetch } from "../vendor/checkout-node/test/helpers/fetch.js";
import { withCall, type Services } from "../src/protocol/context.js";
import { parseAssistantKey } from "../src/protocol/key.js";
import { deriveAssistantKeys } from "../src/protocol/keys.js";

import { vectors as assistant } from "./helpers/vectors.js";

/*
 * Each source of the export (SPEC.md §20) read from records the merchant's app published
 * (vectors/app/export.json, `sources`), with the keys of the app's grant: the lines are the app's.
 */

type Source = { range: { start: number; end: number }; events: NostrEvent[]; lines: Line[] };

const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "vectors", "app", "export.json"), "utf8")
) as {
  grant: { keys: ExportKeys };
  sources: {
    sends: Source;
    history: Source & { later: Record<"pending" | "newer", NostrEvent> };
    till: Source & {
      chain: {
        address: string;
        txid: string;
        sats: number;
        confirmations: number;
        received: number;
      }[];
    };
  };
};

const RELAYS = ["wss://relay.example", "wss://relay-b.example", "wss://relay-c.example"];
const keys = deriveAssistantKeys(parseAssistantKey(assistant.secretKey).key);
const { account } = vectors.grant.keys;
let net: RelayNet;

function services(
  fetch: typeof globalThis.fetch = () => Promise.reject(new Error("no HTTP here"))
): Services {
  return {
    createSocket: (url: string) => new net.WebSocket(url),
    fetch,
    timeoutMs: 2000,
    now: () => 1_793_100_000
  };
}

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

const byId = (lines: readonly Line[]) => [...lines].sort((a, b) => (a.id < b.id ? -1 : 1));

beforeEach(() => {
  net = new RelayNet();
});

afterEach(async () => {
  await net.close();
});

describe("the sendings", () => {
  const { sends } = vectors.sources;
  const read = (range = sends.range) =>
    withCall(services(), (call) => readSendLines(call, RELAYS, account, keys.member.nostr, range));

  it("are the lines the app's records make, each with its recorded rate", async () => {
    await relaysHolding(sends.events);
    expect(byId(await read())).toEqual(byId(sends.lines));
  });

  it("are those of the period only", async () => {
    await relaysHolding(sends.events);
    const first = sends.lines.reduce((a, b) => (a.at <= b.at ? a : b));
    const lines = await read({ start: first.at, end: first.at });
    expect(lines.map(({ id }) => id)).toEqual([first.id]);
  });

  it("are not told without a majority of the relays", async () => {
    await relaysHolding(sends.events, RELAYS.slice(1));
    await expect(read()).rejects.toMatchObject({ code: "network" });
  });

  it("leave out a record that is not one of the account's (another author)", async () => {
    const forged = sends.events.map((event) => ({ ...event, pubkey: "ab".repeat(32) }));
    await relaysHolding(forged);
    expect(await read()).toEqual([]);
  });
});

describe("the v2 history", () => {
  const { history } = vectors.sources;
  const read = (range = history.range) =>
    withCall(services(), (call) =>
      readHistoryLines(call, RELAYS, account.legacyHistory, keys.member.nostr, range)
    );
  // The lines of October (from 1.10.2026 00:00 UTC); the events: September's two parts, October's
  // part, then the state, as the app wrote them.
  const october = history.lines.filter(({ at }) => at >= 1_790_812_800);

  it("is the lines of the rows the app copied, within the period", async () => {
    await relaysHolding(history.events);
    const { lines, incomplete } = await read();
    expect(byId(lines)).toEqual(byId(history.lines));
    expect(incomplete).toBe(false);
  });

  it("reads the months of the period only, and their rows within it", async () => {
    await relaysHolding(history.events);
    const start = 1_790_812_800; // 1.10.2026 00:00 UTC
    const { lines } = await read({ start, end: history.range.end });
    expect(byId(lines)).toEqual(byId(october));
    expect(october.length).toBeGreaterThan(0);
  });

  it("leaves out a month without every part of its copy, and says the history is incomplete", async () => {
    // Each relay misses the same part of September (two parts): half a month is never read.
    const septemberParts = history.events.length - 2; // all but October's part and the state
    expect(septemberParts).toBe(2);
    await relaysHolding(history.events.filter((_, index) => index !== 1));
    const { lines, incomplete } = await read();
    expect(byId(lines)).toEqual(byId(october));
    expect(incomplete).toBe(true);
  });

  it("is read whole when a majority holds every part between them", async () => {
    for (const [index, url] of RELAYS.entries()) {
      const relay = await net.add(url);
      // Each relay misses one record; together they hold all of them.
      for (const [rank, event] of history.events.entries()) if (rank !== index) relay.take(event);
    }
    const { lines, incomplete } = await read();
    expect(byId(lines)).toEqual(byId(history.lines));
    expect(incomplete).toBe(false);
  });

  it("says a copy started again and not finished", async () => {
    await relaysHolding([...history.events, history.later.pending]);
    const { lines, incomplete } = await read();
    expect(byId(lines)).toEqual(byId(history.lines));
    expect(incomplete).toBe(true);
  });

  it("is never read past a month of a newer format", async () => {
    await relaysHolding([...history.events, history.later.newer]);
    await expect(read()).rejects.toMatchObject({ code: "newer" });
    // A period without that month is read.
    const { lines } = await read({ start: history.range.start, end: 1_790_812_799 });
    expect(byId(lines)).toEqual(byId(history.lines.filter(({ at }) => at < 1_790_812_800)));
  });

  it("is not told without a majority of the relays", async () => {
    await relaysHolding(history.events, RELAYS.slice(1));
    await expect(read()).rejects.toMatchObject({ code: "network" });
  });

  it("leaves out records of another author", async () => {
    const forged = history.events.map((event) => ({ ...event, pubkey: "ab".repeat(32) }));
    await relaysHolding(forged);
    expect(await read()).toEqual({ lines: [], incomplete: false });
  });

  it("covers each month of a period, in UTC", () => {
    expect(monthsOf({ start: 1_789_862_400, end: 1_791_676_799 })).toEqual(["2026-09", "2026-10"]);
    expect(monthsOf({ start: 1_798_761_599, end: 1_798_761_600 })).toEqual(["2026-12", "2027-01"]);
    expect(monthsOf({ start: 1_790_812_800, end: 1_790_812_800 })).toEqual(["2026-10"]);
  });
});

describe("the sales of the points of sale", () => {
  const { till } = vectors.sources;
  // The channel of the same team (vectors/app/assistant.json): its registry and link owner keys.
  const channel = assistant.channel.value as { registryKey: string; linkOwner: string };

  /** The explorer, as `till.chain` tells it. */
  function explorer() {
    const chain = new FakeChain();
    for (const tx of till.chain) {
      chain.add(
        tx.address,
        payment(tx.txid, tx.address, tx.sats, { height: chain.height - tx.confirmations + 1 })
      );
      chain.received.set(tx.txid, new Date(tx.received * 1000).toISOString());
    }
    return fakeFetch((url) => {
      const href = url.href;
      if (href.startsWith("https://mempool.space/api/v1/tx/")) {
        return { json: { replacements: null, replaces: null } };
      }
      return chain.route(url) ?? { status: 404, text: "Not found" };
    });
  }

  it("are the lines the app's records make, each payment checked", async () => {
    await relaysHolding(till.events);
    const { lines, setAside } = await withCall(services(explorer().fetch), (call) =>
      readTillLines(call, {
        relays: RELAYS,
        seats: tillSeatsOf(vectors.grant.keys.seats),
        auth: keys.member.nostr,
        registryKey: channel.registryKey,
        linkOwner: channel.linkOwner,
        bitcoinNode: null,
        range: till.range
      })
    );
    expect(setAside).toEqual([]);
    expect(lines).toEqual(till.lines);
  });
});
