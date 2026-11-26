import { createServer } from "node:https";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import {
  ClientDocumentError,
  ClientDocuments,
  clientOfDocument,
  documentUrl,
  fetchDocument,
  freshSeconds,
  isPublicAddress,
  type FetchedDocument
} from "../src/hosted/cimd.js";

/*
 * Clients' metadata documents (src/hosted/cimd.ts): which URLs are fetched, from which addresses,
 * which documents describe a client, and how long one is kept.
 */

const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";
// Claude Code's document as claude.ai serves it.
const CLAUDE_CODE_DOCUMENT = {
  client_id: CLAUDE_CODE,
  client_name: "Claude Code",
  client_uri: "https://claude.ai",
  redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none"
};
const CHATGPT = "https://chatgpt.com/oauth/client.json";
// As ChatGPT's documentation describes its document (both methods, the singular one legacy).
const CHATGPT_DOCUMENT = {
  client_id: CHATGPT,
  client_name: "ChatGPT",
  redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
  token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
  token_endpoint_auth_method: "private_key_jwt",
  jwks_uri: "https://chatgpt.com/oauth/jwks.json"
};

describe("a client's document URL", () => {
  it.each([CLAUDE_CODE, CHATGPT, "https://example.com:8443/client"])("accepts %s", (url) => {
    expect(documentUrl(url)?.href).toBe(url);
  });

  it.each([
    ["http", "http://claude.ai/oauth/client"],
    ["the root", "https://claude.ai/"],
    ["no path", "https://claude.ai"],
    ["a user", "https://user@claude.ai/client"],
    ["a query", "https://claude.ai/client?x=1"],
    ["a fragment", "https://claude.ai/client#x"],
    ["a dot segment", "https://claude.ai/a/../client"],
    ["an encoded dot segment", "https://claude.ai/a/%2e%2e/client"],
    ["an unnormalized host", "https://Claude.ai/client"],
    ["a space", "https://claude.ai/my client"],
    ["not a URL", "sattleme-client"]
  ])("refuses %s", (_, url) => {
    expect(documentUrl(url)).toBeNull();
  });
});

describe("the addresses a document is fetched from", () => {
  it.each(["104.18.32.47", "2606:4700::6812:202f", "8.8.8.8"])("accepts public %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.5",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fd12::1",
    "fe80::1",
    "ff02::1",
    "64:ff9b::7f00:1",
    "2001:db8::1",
    "2002:7f00:1::1",
    "2001::1",
    "localhost"
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it("never connects to this machine, by its name or its address", async () => {
    // A server on this machine that would answer a document: never reached.
    let reached = false;
    const server = createServer((_, res) => {
      reached = true;
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      for (const url of [
        `https://localhost:${port}/client`,
        `https://127.0.0.1:${port}/client`,
        `https://[::1]:${port}/client`
      ]) {
        await expect(fetchDocument(new URL(url))).rejects.toMatchObject({
          message: "not a public address",
          transient: false
        });
      }
      expect(reached).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("a client's document", () => {
  const read = (url: string, document: unknown, allowed: readonly string[] | null = null) =>
    clientOfDocument(new URL(url), JSON.stringify(document), allowed);

  it("describes Claude Code, a public client of the loopback address", () => {
    expect(read(CLAUDE_CODE, CLAUDE_CODE_DOCUMENT)).toEqual({
      client_id: CLAUDE_CODE,
      client_name: "Claude Code",
      redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"]
    });
  });

  it("describes ChatGPT, public here though it can also sign (the methods both support)", () => {
    expect(read(CHATGPT, CHATGPT_DOCUMENT)).toMatchObject({
      client_id: CHATGPT,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"]
    });
  });

  it.each([
    ["another client_id", { client_id: "https://evil.example/client" }],
    ["a client_id written otherwise", { client_id: `${CLAUDE_CODE}/` }],
    ["no redirect URI", { redirect_uris: [] }],
    ["a redirect a browser would run", { redirect_uris: ["javascript:alert(1)"] }],
    ["a shared secret", { client_secret: "s3cret" }],
    ["a secret method only", { token_endpoint_auth_method: "client_secret_basic" }],
    [
      "secret methods only",
      { token_endpoint_auth_methods_supported: ["client_secret_post", "private_key_jwt"] }
    ],
    ["no authorization code", { grant_types: ["client_credentials"] }],
    ["both jwks and jwks_uri", { jwks: { keys: [] }, jwks_uri: "https://claude.ai/jwks" }]
  ])("is refused with %s", (_, change) => {
    expect(() => read(CLAUDE_CODE, { ...CLAUDE_CODE_DOCUMENT, ...change })).toThrow(
      ClientDocumentError
    );
  });

  it("is refused when it is not a JSON object", () => {
    expect(() => clientOfDocument(new URL(CLAUDE_CODE), "<html>", null)).toThrow(/not JSON/);
    expect(() => clientOfDocument(new URL(CLAUDE_CODE), "[]", null)).toThrow(/not a JSON object/);
  });

  it("is refused when the server lists other redirect URIs", () => {
    expect(() =>
      read(CLAUDE_CODE, CLAUDE_CODE_DOCUMENT, ["https://claude.ai/api/mcp/auth_callback"])
    ).toThrow(/redirect URIs are not allowed/);
  });
});

describe("the documents kept", () => {
  it("are fresh as their Cache-Control says, between a minute and a day", () => {
    expect(freshSeconds(null)).toBe(3600);
    expect(freshSeconds("public, max-age=600")).toBe(600);
    expect(freshSeconds("max-age=5")).toBe(60);
    expect(freshSeconds("max-age=9999999")).toBe(86_400);
    expect(freshSeconds("no-store")).toBe(0);
    expect(freshSeconds("private, no-cache")).toBe(0);
  });

  function documents(answers: (() => FetchedDocument)[]) {
    let now = 1_000_000;
    const fetched: string[] = [];
    const store = new ClientDocuments({
      fetch: (url) => {
        fetched.push(url.href);
        const answer = answers.shift();
        if (!answer) throw new Error("no answer left");
        return Promise.resolve(answer());
      },
      now: () => now,
      allowedRedirects: null,
      own: ["https://mcp.sattle.test/"]
    });
    return { store, fetched, wait: (seconds: number) => (now += seconds) };
  }
  const document =
    (cacheControl: string | null = null) =>
    () => ({
      body: JSON.stringify(CLAUDE_CODE_DOCUMENT),
      cacheControl
    });
  const failing = (transient: boolean) => () => {
    throw new ClientDocumentError("answered", transient);
  };

  it("reads a document once while it is fresh, and once for requests at the same time", async () => {
    const { store, fetched, wait } = documents([document("max-age=600"), document()]);
    await Promise.all([store.client(CLAUDE_CODE), store.client(CLAUDE_CODE)]);
    await store.client(CLAUDE_CODE);
    expect(fetched).toHaveLength(1);
    wait(601);
    await store.client(CLAUDE_CODE);
    expect(fetched).toHaveLength(2);
  });

  it("keeps a document a day while its server cannot be reached, never past it", async () => {
    const { store, wait } = documents([document(), failing(true), failing(true)]);
    await store.client(CLAUDE_CODE);
    wait(3601);
    await expect(store.client(CLAUDE_CODE)).resolves.toMatchObject({ client_id: CLAUDE_CODE });
    wait(86_400);
    await expect(store.client(CLAUDE_CODE)).rejects.toThrow(ClientDocumentError);
  });

  it("forgets a document its server now refuses", async () => {
    const { store, wait } = documents([document(), failing(false), document()]);
    await store.client(CLAUDE_CODE);
    wait(3601);
    await expect(store.client(CLAUDE_CODE)).rejects.toMatchObject({ transient: false });
    await expect(store.client(CLAUDE_CODE)).resolves.toMatchObject({ client_id: CLAUDE_CODE });
  });

  it("never keeps a document it refused, nor fetches a URL that is not one", async () => {
    const { store, fetched } = documents([
      () => ({
        body: JSON.stringify({ ...CLAUDE_CODE_DOCUMENT, client_secret: "x" }),
        cacheControl: null
      }),
      document()
    ]);
    await expect(store.client(CLAUDE_CODE)).rejects.toThrow(/holds a secret/);
    await expect(store.client(CLAUDE_CODE)).resolves.toMatchObject({ client_id: CLAUDE_CODE });
    await expect(store.client("https://claude.ai/")).rejects.toThrow(ClientDocumentError);
    await expect(store.client("https://mcp.sattle.test/")).rejects.toThrow(ClientDocumentError);
    expect(fetched).toEqual([CLAUDE_CODE, CLAUDE_CODE]);
  });
});
