import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type WsWebSocket from "ws";

import { publicFetch, publicWebSocket, hostedServices } from "../src/hosted/egress.js";
import { withCall } from "../src/protocol/context.js";
import { readChannel } from "../src/protocol/channel.js";
import { World } from "./helpers/world.js";

/*
 * What the hosted server reaches on a merchant's behalf (src/hosted/egress.ts): public addresses
 * only, https and wss only, relays on port 443 only; and the Bitcoin nodes it does not read.
 * A TCP server on the loopback address counts the connections it gets: a refused URL gets none.
 */

let server: Server;
let port: number;
let connections = 0;

beforeAll(async () => {
  server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** The error `url`'s WebSocket ends with (asynchronously, once its address is looked up). */
function socketError(url: string): Promise<NodeJS.ErrnoException> {
  const socket = publicWebSocket(url, 2000) as unknown as WsWebSocket;
  return new Promise((resolve) => socket.on("error", resolve));
}

describe("the hosted server's HTTP requests", () => {
  it("never connect to this machine nor a private address, literal or looked up", async () => {
    const before = connections;
    for (const url of [
      `https://127.0.0.1:${port}/`,
      `https://[::1]:${port}/`,
      `https://10.0.0.1/`,
      `https://169.254.169.254/latest/meta-data/`,
      `https://[::ffff:127.0.0.1]:${port}/`
    ]) {
      await expect(publicFetch(url)).rejects.toMatchObject({
        name: "TypeError",
        cause: { name: "EgressRefused", message: `${url}: not a public address` }
      });
    }
    // A name: refused once looked up (publicLookup), before any connection.
    await expect(publicFetch(`https://localhost:${port}/`)).rejects.toMatchObject({
      name: "TypeError",
      cause: { code: "ENOTPUBLIC" }
    });
    expect(connections).toBe(before);
  });

  it("are https only", async () => {
    const before = connections;
    for (const url of [`http://localhost:${port}/`, "ftp://example.com/", "not a url"]) {
      await expect(publicFetch(url)).rejects.toMatchObject({ name: "TypeError" });
    }
    expect(connections).toBe(before);
  });
});

describe("the hosted server's WebSockets (its relays)", () => {
  it("are wss on port 443 only", () => {
    for (const [url, why] of [
      ["ws://relay.example", "not wss"],
      [`wss://relay.example:${port}`, `port ${port} not allowed`],
      ["wss://relay.example:22", "port 22 not allowed"],
      ["wss://relay.example:8443/nostr", "port 8443 not allowed"]
    ] as const) {
      expect(() => publicWebSocket(url, 2000)).toThrow(`${url}: ${why}`);
    }
  });

  it("never connect to this machine nor a private address, literal or looked up", async () => {
    const before = connections;
    for (const url of [
      "wss://127.0.0.1",
      "wss://[::1]",
      "wss://192.168.1.1",
      "wss://10.0.0.1:443"
    ]) {
      expect(() => publicWebSocket(url, 2000)).toThrow(`${url}: not a public address`);
    }
    expect(await socketError("wss://localhost")).toMatchObject({ code: "ENOTPUBLIC" });
    expect(connections).toBe(before);
  });

  it("make the hosted services, with a public-only call", async () => {
    const services = hostedServices(1000);
    expect(services.publicOnly).toBe(true);
    expect(services.timeoutMs).toBe(1000);
    expect(() => services.createSocket("wss://127.0.0.1")).toThrow("not a public address");
    await withCall(services, async (call) => expect(call.publicOnly).toBe(true));
  });
});

describe("the merchant's Bitcoin node, as the hosted server reads the channel", () => {
  const read = async (bitcoinNode: unknown, publicOnly: boolean) => {
    const world = await new World().start();
    try {
      world.publishChannel(world.channelValue(world.now - 60, { bitcoinNode }), world.now - 60);
      const services = { ...world.services(), publicOnly };
      return (await withCall(services, (call) => readChannel(call, world.access, world.keys)))
        .bitcoinNode;
    } finally {
      await world.stop();
    }
  };

  it("sets aside a node that is not of the Internet, mempool.space reading in its place", async () => {
    for (const url of [
      "http://umbrel.local",
      "https://umbrel.local",
      "http://192.168.1.20:3006",
      "https://203.0.114.7"
    ]) {
      const node = { url, fallback: "mempool", payers: false };
      expect(await read(node, true)).toBeNull();
      // Claude Desktop's server, on the merchant's network, reads it.
      expect(await read(node, false)).toEqual(node);
    }
  });

  it("keeps a node of the Internet, and a node whose fallback is none (never mempool.space)", async () => {
    const internet = { url: "https://node.example.com", fallback: "mempool", payers: true };
    expect(await read(internet, true)).toEqual(internet);
    // Its reads are refused by the hosted fetch (http, a private address): they fail as the node's.
    const none = { url: "http://umbrel.local", fallback: "none", payers: false };
    expect(await read(none, true)).toEqual(none);
    await expect(publicFetch("http://umbrel.local/api/blocks/tip/height")).rejects.toMatchObject({
      cause: { name: "EgressRefused" }
    });
  });
});
