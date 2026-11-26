import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";

import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { depositAddress } from "../vendor/checkout-node/test/helpers/chain.js";

import { CLAUDE_REDIRECTS, createHostedApp } from "../src/hosted/app.js";
import { ClientDocumentError, type FetchedDocument } from "../src/hosted/cimd.js";
import { Sealer } from "../src/hosted/seal.js";
import { loadFonts } from "../src/pdf/invoice-pdf.js";
import { pointHour } from "../src/protocol/points.js";

import { grantExport, paidTillSale } from "./helpers/export-world.js";
import { World } from "./helpers/world.js";

/*
 * The hosted server (SPEC.md §16) on a local port: Claude's OAuth flow (registration, consent,
 * code, token, refresh), then MCP calls with its token, against the test merchant.
 */

const REDIRECT = CLAUDE_REDIRECTS[0];
let world: World;
let http: Server;
let base: string;
/** Seconds added to the real clock: the SDK checks a token's expiry against it. */
let offset = 0;
/** How clients' documents answer (cimd.ts): never the network in tests. */
let documentAnswer: (url: URL) => Promise<FetchedDocument> = () =>
  Promise.reject(new ClientDocumentError("no network in tests", false));

beforeEach(async () => {
  offset = 0;
  documentAnswer = () => Promise.reject(new ClientDocumentError("no network in tests", false));
  world = await new World().start();
  world.publishChannel(world.channelValue(world.now - 100), world.now - 100);
  world.publishLot([depositAddress("hosted 1")], world.now - 90);
  const app = createHostedApp({
    sealer: new Sealer(new Uint8Array(32).fill(42)),
    publicUrl: new URL("https://mcp.sattle.test"),
    allowedRedirects: null,
    services: () => world.services(),
    timeZone: "Europe/Zurich",
    language: "fr",
    version: "0.0.0-test",
    now: () => Math.floor(Date.now() / 1000) + offset,
    fetchClientDocument: (url) => documentAnswer(url)
  });
  http = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => http.close(resolve));
  await world.stop();
});

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

async function register(redirects: string[] = [REDIRECT]) {
  return fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: redirects,
      token_endpoint_auth_method: "none"
    })
  });
}

/**
 * The flow up to the code: registration, the consent page, the key given, from a browser that
 * prefers `acceptLanguage` (its Accept-Language, when given).
 */
async function consent(
  key: string,
  redirect: string = REDIRECT,
  registered: string = redirect,
  acceptLanguage?: string
) {
  const client = (await (await register([registered])).json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${base}/authorize`);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st4te",
    // The address as MCP clients write it: the origin, without a trailing slash.
    resource: "https://mcp.sattle.test"
  })) {
    authorize.searchParams.set(name, value);
  }
  const page = await fetch(authorize);
  const html = await page.text();
  const request = /name="request" value="([^"]+)"/.exec(html)![1]!;
  const answer = await fetch(`${base}/consent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(acceptLanguage === undefined ? {} : { "Accept-Language": acceptLanguage })
    },
    body: form({ request, key }),
    redirect: "manual"
  });
  return { client, verifier, page, html, answer };
}

async function token(fields: Record<string, string>) {
  return fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form(fields)
  });
}

describe("the hosted server", () => {
  it("publishes its OAuth metadata and its resource's", async () => {
    const metadata = (await (
      await fetch(`${base}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      issuer: "https://mcp.sattle.test/",
      registration_endpoint: "https://mcp.sattle.test/register",
      code_challenge_methods_supported: ["S256"],
      // Clients' metadata documents (CIMD) for public clients, and `iss` in every answer.
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true
    });
    expect(metadata.token_endpoint_auth_methods_supported).toContain("none");
    // The MCP endpoint is the origin: its metadata at the root's well-known URI (RFC 9728), its
    // resource written as MCP clients write the address, without a trailing slash.
    const resource = (await (
      await fetch(`${base}/.well-known/oauth-protected-resource`)
    ).json()) as Record<string, unknown>;
    expect(resource).toEqual({
      resource: "https://mcp.sattle.test",
      authorization_servers: ["https://mcp.sattle.test/"],
      scopes_supported: ["invoices"],
      resource_name: "sattle.me"
    });
    // As the SDK's own client checks it against the address it was given, with or without a slash.
    for (const address of ["https://mcp.sattle.test", "https://mcp.sattle.test/"]) {
      expect(
        checkResourceAllowed({
          requestedResource: address,
          configuredResource: resource.resource as string
        })
      ).toBe(true);
    }
  });

  it("asks consent for its own address only, with or without a trailing slash", async () => {
    const client = (await (await register()).json()) as { client_id: string };
    const authorize = (resource: string) => {
      const url = new URL(`${base}/authorize`);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: createHash("sha256").update("verifier").digest("base64url"),
        code_challenge_method: "S256",
        resource
      }).toString();
      return fetch(url, { redirect: "manual" });
    };
    expect((await authorize("https://mcp.sattle.test")).status).toBe(200);
    expect((await authorize("https://mcp.sattle.test/")).status).toBe(200);
    expect((await authorize("https://mcp.sattle.test/mcp")).status).toBe(400);
    expect((await authorize("https://other.test")).status).toBe(400);
  });

  it.each([
    ["registers (DCR)", null],
    [
      "gives its metadata document's URL as its client_id (CIMD)",
      "https://ai.example/oauth/client.json"
    ]
  ])(
    "is found from its address alone by the SDK's own MCP client, which %s",
    async (_, documentUrl) => {
      // A server whose public address is the one the client reaches (here, a loopback origin).
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const redirect = "http://127.0.0.1:33418/callback";
      // The client's document, as its own server would serve it: its loopback redirect, any port.
      const documentsRead: string[] = [];
      server.on(
        "request",
        createHostedApp({
          sealer: new Sealer(new Uint8Array(32).fill(7)),
          publicUrl: new URL(address),
          allowedRedirects: null,
          services: () => world.services(),
          timeZone: "Europe/Zurich",
          language: "fr",
          version: "0.0.0-test",
          fetchClientDocument: (url) => {
            documentsRead.push(url.href);
            return Promise.resolve({
              body: JSON.stringify({
                client_id: documentUrl,
                client_name: "An AI app",
                redirect_uris: ["http://127.0.0.1/callback"],
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                token_endpoint_auth_method: "none"
              }),
              cacheControl: "max-age=300"
            });
          }
        })
      );
      try {
        // What an AI app keeps: its registration, the PKCE verifier, the tokens.
        let information: OAuthClientInformationMixed | undefined;
        let verifier = "";
        let saved: OAuthTokens | undefined;
        let consentUrl: URL | undefined;
        const requested: string[] = [];
        const fetchFn = (url: string | URL, init?: RequestInit) => {
          requested.push(new URL(url).pathname);
          return fetch(url, init);
        };
        const provider: OAuthClientProvider = {
          redirectUrl: redirect,
          ...(documentUrl ? { clientMetadataUrl: documentUrl } : {}),
          clientMetadata: {
            client_name: "An AI app",
            redirect_uris: [redirect],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"]
          },
          clientInformation: () => information,
          saveClientInformation: (value) => {
            information = value;
          },
          tokens: () => saved,
          saveTokens: (value) => {
            saved = value;
          },
          redirectToAuthorization: (url) => {
            consentUrl = url;
          },
          saveCodeVerifier: (value) => {
            verifier = value;
          },
          codeVerifier: () => verifier
        };
        // The merchant pastes the address, without a trailing slash.
        expect(await auth(provider, { serverUrl: address, fetchFn })).toBe("REDIRECT");
        expect(consentUrl!.searchParams.get("resource")).toBe(address);
        if (documentUrl) {
          // No registration: its client_id is its document's URL, which the server read.
          expect(requested).not.toContain("/register");
          expect(consentUrl!.searchParams.get("client_id")).toBe(documentUrl);
        } else {
          expect(requested).toContain("/register");
        }
        const page = await (await fetch(consentUrl!)).text();
        // The app asking named by the host its document proves, else by the name it declares.
        expect(page).toContain(
          documentUrl
            ? "<strong>ai.example</strong> (« An AI app ») demande"
            : "« An AI app » demande"
        );
        const request = /name="request" value="([^"]+)"/.exec(page)![1]!;
        const answer = await fetch(`${address}/consent`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form({ request, key: world.keyText }),
          redirect: "manual"
        });
        const back = new URL(answer.headers.get("location")!);
        // The issuer named in the answer (RFC 9207).
        expect(back.searchParams.get("iss")).toBe(`${address}/`);
        const code = back.searchParams.get("code")!;
        expect(await auth(provider, { serverUrl: address, authorizationCode: code, fetchFn })).toBe(
          "AUTHORIZED"
        );
        const mcp = new Client({ name: "an-ai-app", version: "1" });
        await mcp.connect(
          new StreamableHTTPClientTransport(new URL(address), { authProvider: provider })
        );
        const profile = (await mcp.callTool({ name: "business_profile", arguments: {} })) as {
          content: { text: string }[];
        };
        expect(JSON.parse(profile.content[0]!.text)).toHaveProperty("businessName");
        await mcp.close();
        // Read once, kept while fresh, by the consent and the token's exchange alike.
        expect(documentsRead).toEqual(documentUrl ? [documentUrl] : []);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  );

  it("never sends the merchant to a client whose document cannot serve", async () => {
    const authorize = () => {
      const url = new URL(`${base}/authorize`);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: "https://ai.example/oauth/client.json",
        redirect_uri: "https://ai.example/callback",
        code_challenge: createHash("sha256").update("verifier").digest("base64url"),
        code_challenge_method: "S256"
      }).toString();
      return fetch(url, { redirect: "manual" });
    };
    // A document that is not its client's: refused, the merchant left here.
    documentAnswer = () =>
      Promise.resolve({
        body: JSON.stringify({
          client_id: "https://other.example/client.json",
          redirect_uris: ["https://ai.example/callback"]
        }),
        cacheControl: null
      });
    const refused = await authorize();
    expect(refused.status).toBe(400);
    expect(refused.headers.get("location")).toBeNull();
    expect(await refused.json()).toMatchObject({ error: "invalid_client" });
    // Its server unreachable: a server error, try again later.
    documentAnswer = () => Promise.reject(new ClientDocumentError("unreachable", true));
    const unreachable = await authorize();
    expect(unreachable.status).toBe(500);
    expect(unreachable.headers.get("location")).toBeNull();
  });

  it("gives an invoice's PDF as a link of 15 minutes, read again at each download", async () => {
    world.setPoints("CHF", pointHour(world.now) - 48 * 3600, pointHour(world.now) + 3600, 80_000);
    const { client, verifier, answer } = await consent(world.keyText);
    const tokens = (await (
      await token({
        grant_type: "authorization_code",
        code: new URL(answer.headers.get("location")!).searchParams.get("code")!,
        code_verifier: verifier,
        client_id: client.client_id,
        redirect_uri: REDIRECT
      })
    ).json()) as { access_token: string };
    const mcp = new Client({ name: "claude-test", version: "1" });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(base), {
        requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } }
      })
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await mcp.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { type: string; text: string }[];
      };
      return { result, value: JSON.parse(result.content[0]!.text) as Record<string, string> };
    };
    const made = await call("create_invoice", {
      recipient: {
        name: "Dupont SA",
        street: "Gare 12",
        postalCode: "1003",
        city: "Lausanne",
        country: "CH"
      },
      lines: [{ description: "Conseil", unitPrice: "100", vatRate: "0" }],
      dueDate: "2026-12-03",
      timeZone: "Europe/Zurich",
      expectedTotal: "100"
    });
    expect(made.value.number).toBe("2026-0001");

    const { result, value } = await call("invoice_pdf", { reference: "2026-0001" });
    await mcp.close();
    // A link, never the file in the answer (an AI app may not take it).
    expect(result.content.map(({ type }) => type)).toEqual(["text"]);
    expect(value.file).toBe("Facture-2026-0001.pdf");
    const url = new URL(value.url!);
    expect(url.origin).toBe("https://mcp.sattle.test");
    expect(url.pathname).toMatch(/^\/pdf\/[\w-]+\/Facture-2026-0001\.pdf$/);
    // The key never readable in it.
    expect(value.url).not.toContain(world.keyText.slice(12));
    expect(Date.parse(value.expiresAt!) - Date.now()).toBeGreaterThan(14 * 60_000);
    // The model downloads the file itself to work with it, and knows which host to have allowed.
    expect(value.howTo).toContain("curl");
    expect(value.howTo).toContain("allow the domain mcp.sattle.test");
    expect(value.howTo).toContain("call invoice_pdf again");

    const download = () => fetch(`${base}${url.pathname}`);
    const pdf = await download();
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toContain('filename="Facture-2026-0001.pdf"');
    expect(pdf.headers.get("cache-control")).toBe("no-store");
    expect(
      Buffer.from(await pdf.arrayBuffer())
        .subarray(0, 5)
        .toString("latin1")
    ).toBe("%PDF-");
    // Another token, or one changed: no PDF.
    const forged = url.pathname.replace(/\/pdf\/([\w-]{10})/, "/pdf/AAAAAAAAAA");
    expect((await fetch(`${base}${forged}`)).status).toBe(410);
    // The merchant removed the assistant: the link stops at once.
    world.publishChannel(
      { version: 1, status: "removed", updatedAt: world.now - 5 },
      world.now - 5
    );
    expect((await download()).status).toBe(403);
    // Past its 15 minutes, expired.
    offset = 15 * 60 + 1;
    expect((await download()).status).toBe(410);
  });

  it("keeps the languages of the browser the merchant connected with, for its invoices' region", async () => {
    world.setPoints("CHF", pointHour(world.now) - 48 * 3600, pointHour(world.now) + 3600, 80_000);
    const sealer = new Sealer(new Uint8Array(32).fill(42));
    const opened = (purpose: "access" | "refresh" | "pdf", text: string) =>
      sealer.open(purpose, text, Math.floor(Date.now() / 1000))!;
    const { client, verifier, answer } = await consent(
      world.keyText,
      REDIRECT,
      REDIRECT,
      "de-CH,de;q=0.9,*;q=0.5,en;q=0.8,xx-!!;q=0.7"
    );
    const tokens = (await (
      await token({
        grant_type: "authorization_code",
        code: new URL(answer.headers.get("location")!).searchParams.get("code")!,
        code_verifier: verifier,
        client_id: client.client_id,
        redirect_uri: REDIRECT
      })
    ).json()) as { access_token: string; refresh_token: string };
    // Sealed in both tokens, by weight, what is no language left out.
    expect(opened("access", tokens.access_token).preferences).toEqual(["de-CH", "de", "en"]);
    expect(opened("refresh", tokens.refresh_token).preferences).toEqual(["de-CH", "de", "en"]);
    // Kept when the tokens are refreshed.
    const refreshed = (await (
      await token({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: client.client_id
      })
    ).json()) as { access_token: string };
    expect(opened("access", refreshed.access_token).preferences).toEqual(["de-CH", "de", "en"]);
    // And in an invoice's PDF link.
    const mcp = new Client({ name: "claude-test", version: "1" });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(base), {
        requestInit: { headers: { Authorization: `Bearer ${refreshed.access_token}` } }
      })
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await mcp.callTool({ name, arguments: args })) as {
        content: { type: string; text: string }[];
      };
      return JSON.parse(result.content[0]!.text) as Record<string, string>;
    };
    await call("create_invoice", {
      recipient: {
        name: "Dupont SA",
        street: "Gare 12",
        postalCode: "1003",
        city: "Lausanne",
        country: "CH"
      },
      lines: [{ description: "Conseil", unitPrice: "100", vatRate: "0" }],
      dueDate: "2026-12-03",
      timeZone: "Europe/Zurich",
      expectedTotal: "100"
    });
    const link = new URL(
      (await call("invoice_pdf", { reference: "2026-0001", language: "de" })).url!
    );
    await mcp.close();
    const sealed = /^\/pdf\/([\w-]+)\//.exec(link.pathname)![1]!;
    expect(opened("pdf", sealed).preferences).toEqual(["de-CH", "de", "en"]);
    const pdf = await fetch(`${base}${link.pathname}`);
    expect(pdf.status).toBe(200);
    // A browser that tells none: none, and the PDF still made (the merchant's other signals).
    const plain = await consent(world.keyText);
    const plainTokens = (await (
      await token({
        grant_type: "authorization_code",
        code: new URL(plain.answer.headers.get("location")!).searchParams.get("code")!,
        code_verifier: plain.verifier,
        client_id: plain.client.client_id,
        redirect_uri: REDIRECT
      })
    ).json()) as { access_token: string };
    expect(opened("access", plainTokens.access_token).preferences).toEqual([]);
  });

  it("gives an export as a link of 15 minutes, made again at each download", async () => {
    world.setPoints("CHF", pointHour(world.now) - 48 * 3600, pointHour(world.now) + 3600, 80_000);
    grantExport(world);
    paidTillSale(world);
    const { client, verifier, answer } = await consent(world.keyText);
    const tokens = (await (
      await token({
        grant_type: "authorization_code",
        code: new URL(answer.headers.get("location")!).searchParams.get("code")!,
        code_verifier: verifier,
        client_id: client.client_id,
        redirect_uri: REDIRECT
      })
    ).json()) as { access_token: string };
    const mcp = new Client({ name: "claude-test", version: "1" });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(base), {
        requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } }
      })
    );
    const result = (await mcp.callTool({
      name: "export_transactions",
      arguments: { first: "2026-11-03", last: "2026-11-03", format: "csv" }
    })) as { content: { type: string; text: string }[] };
    await mcp.close();
    expect(result.content.map(({ type }) => type)).toEqual(["text"]);
    const value = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(value).toMatchObject({ file: "Marie-Conseil_2026-11-03_2026-11-03.csv", lines: 1 });
    const url = new URL(value.url as string);
    expect(url.pathname).toMatch(/^\/export\/[\w-]+\/Marie-Conseil_2026-11-03_2026-11-03\.csv$/);
    expect(value.url).not.toContain(world.keyText.slice(12));
    expect(value.howTo).toContain("allow the domain mcp.sattle.test");
    expect(value.howTo).toContain("notes and setAside");
    const download = () => fetch(`${base}${url.pathname}`);
    const csv = await download();
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(csv.headers.get("cache-control")).toBe("no-store");
    expect(await csv.text()).toContain("Café;Point de Vente");
    // A token of another purpose (an invoice's PDF) never opens as an export's.
    const forged = url.pathname.replace(/\/export\/([\w-]{10})/, "/export/AAAAAAAAAA");
    expect((await fetch(`${base}${forged}`)).status).toBe(410);
    // The merchant withdraws the export: the link stops at once.
    grantExport(world, false, world.now - 10);
    expect((await download()).status).toBe(403);
    // Past its 15 minutes, expired.
    offset = 15 * 60 + 1;
    expect((await download()).status).toBe(410);
  });

  it("limits downloads per assistant key, not per address an AI app's sandboxes share", async () => {
    // Links sealed as the tools seal them, for two keys, downloaded from one address.
    const sealer = new Sealer(new Uint8Array(32).fill(42));
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    const request = { first: "2026-11-03", last: "2026-11-03", format: "csv" };
    const link = (key: string) =>
      `${base}/export/${sealer.seal("export", { key, request }, expiresAt)}/export.csv`;
    const first = link(world.keyText);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await fetch(first)).status);
    expect(statuses.slice(0, 10)).not.toContain(429);
    expect(statuses[10]).toBe(429);
    // Another merchant's assistant, from the same address, is not held back.
    expect((await fetch(link(`${world.keyText}x`))).status).not.toBe(429);
    // A forged token is refused before any key is counted.
    expect((await fetch(`${base}/export/AAAA/export.csv`)).status).toBe(410);
  });

  it("serves its logo, and shows it on its pages", async () => {
    for (const [path, size] of [
      ["/icon.png", 512],
      ["/favicon.png", 48],
      ["/favicon.ico", 48]
    ] as const) {
      const answer = await fetch(`${base}${path}`);
      expect(answer.status).toBe(200);
      expect(answer.headers.get("content-type")).toBe("image/png");
      const png = Buffer.from(await answer.arrayBuffer());
      expect(png.readUInt32BE(16)).toBe(size);
    }
    const page = await fetch(`${base}/`, { headers: { Accept: "text/html" } });
    const html = await page.text();
    expect(html).toContain('<img class="logo" src="/icon.png" alt="sattle.me"');
    expect(html).toContain('<link rel="icon" type="image/png" href="/favicon.png">');
    // Images from the server itself only.
    expect(page.headers.get("content-security-policy")).toContain("img-src 'self';");
  });

  it("serves its pages' font, the brand kit's, and its pages take it from there only", async () => {
    const files = loadFonts();
    for (const [path, file] of [
      ["/fonts/plus-jakarta-sans-medium.ttf", files.medium],
      ["/fonts/plus-jakarta-sans-bold.ttf", files.bold],
      ["/fonts/plus-jakarta-sans-extrabold.ttf", files.extraBold]
    ] as const) {
      const answer = await fetch(`${base}${path}`);
      expect(answer.status).toBe(200);
      expect(answer.headers.get("content-type")).toBe("font/ttf");
      expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await answer.arrayBuffer()).equals(file)).toBe(true);
    }
    const page = await fetch(`${base}/`, { headers: { Accept: "text/html" } });
    const html = await page.text();
    for (const file of ["medium", "bold", "extrabold"]) {
      expect(html).toContain(`url("/fonts/plus-jakarta-sans-${file}.ttf") format("truetype")`);
    }
    expect(page.headers.get("content-security-policy")).toContain("font-src 'self';");
    // Nothing else is loaded: no stylesheet, no script, no font from elsewhere.
    expect(html).not.toMatch(/<script|<link rel="stylesheet"|url\(\s*["']?https?:/i);
  });

  it("says what its address is for to a browser, and the version it runs, and serves no stream", async () => {
    const page = await fetch(`${base}/`, { headers: { Accept: "text/html,*/*;q=0.8" } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toMatch(/^default-src 'none'/);
    const html = await page.text();
    expect(html).toContain("Ajoutez-le à votre application d'IA comme connecteur.");
    // The address merchants paste: the origin, without a trailing slash.
    expect(html).toContain('<p class="address">https://mcp.sattle.test</p>');
    // The domain an AI app's code sandbox must be allowed to reach: this server's own.
    expect(html).toContain("autorisez une fois le domaine <strong>mcp.sattle.test</strong>");
    expect(html).toContain('<small class="version">Version 0.0.0-test</small>');
    const stream = await fetch(`${base}/`, { headers: { Accept: "text/event-stream" } });
    expect(stream.status).toBe(405);
    expect(stream.headers.get("allow")).toBe("POST");
    expect((await fetch(`${base}/`, { method: "DELETE" })).status).toBe(405);
  });

  it("adds itself to Claude by its install link, and leads to ChatGPT's page, running no script", async () => {
    const page = await fetch(`${base}/`, { headers: { Accept: "text/html" } });
    const html = await page.text();
    // Claude's « Add custom connector » dialog, its name and address filled in, escaped in the page
    // (this test server is not sattle.me's own: its connector is named with its host).
    expect(html).toContain(
      '<a class="add" href="https://claude.ai/customize/connectors?modal=add-custom-connector&amp;connectorName=sattle.me%20(mcp.sattle.test)&amp;connectorUrl=https%3A%2F%2Fmcp.sattle.test" target="_blank" rel="noopener noreferrer">Ajouter à Claude</a>'
    );
    // The same dialog for a whole organization, by its owner.
    expect(html).toContain(
      'href="https://claude.ai/admin-settings/connectors?modal=add-custom-connector&amp;connectorName=sattle.me%20(mcp.sattle.test)&amp;connectorUrl=https%3A%2F%2Fmcp.sattle.test"'
    );
    expect(html).toContain(
      '<a class="add" href="https://chatgpt.com/plugins" target="_blank" rel="noopener noreferrer">Ajouter à ChatGPT</a>'
    );
    // Links only: the page still runs no script and posts no form.
    expect(page.headers.get("content-security-policy")).toBe(
      "default-src 'none'; img-src 'self'; font-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<form");
  });

  it("registers any AI app, never a redirect a browser would run", async () => {
    expect((await register()).status).toBe(201);
    expect((await register(["https://chatgpt.com/connector_platform_oauth_redirect"])).status).toBe(
      201
    );
    expect((await register(["http://127.0.0.1:33418/callback"])).status).toBe(201);
    expect((await register(["cursor://anysphere.cursor-retrieval/oauth/callback"])).status).toBe(
      201
    );
    for (const bad of [
      "http://evil.example/callback",
      "javascript:alert(1)",
      "data:text/html,x",
      "https://claude.ai/cb#fragment",
      "https://user:pass@claude.ai/cb"
    ]) {
      expect((await register([bad])).status).toBe(400);
    }
    expect((await register([REDIRECT, "javascript:alert(1)"])).status).toBe(400);
  });

  it("asks the key on its own page, which runs no script", async () => {
    const { page, html } = await consent("nothing");
    expect(page.headers.get("content-security-policy")).toBe(
      "default-src 'none'; img-src 'self'; font-src 'self'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai; frame-ancestors 'none'; base-uri 'none'"
    );
    // Where the code goes, which the merchant checks: the name is only what the app declares.
    expect(html).toContain("« Claude » demande");
    expect(html).toContain("vous revenez sur : <strong>claude.ai</strong>");
    expect(html).not.toContain("<script");
  });

  it("refuses what is not an assistant key, and a removed assistant", async () => {
    const wrong = await consent("sattleme_ck_nope");
    expect(wrong.answer.status).toBe(400);
    expect(await wrong.answer.text()).toContain("Ce n&#39;est pas une clé d&#39;assistant");
    world.publishChannel(
      { version: 1, status: "removed", updatedAt: world.now - 10 },
      world.now - 10
    );
    const removed = await consent(world.keyText);
    expect(await removed.answer.text()).toContain("Cet assistant a été retiré");
  });

  it("gives Claude tokens sealing the key, which serve the tools", async () => {
    const { client, verifier, answer } = await consent(world.keyText);
    expect(answer.status).toBe(302);
    const back = new URL(answer.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("st4te");
    const code = back.searchParams.get("code")!;
    // The key is never readable in what Claude holds.
    expect(code).not.toContain(world.keyText);

    const exchange = {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: REDIRECT
    };
    expect((await token({ ...exchange, code_verifier: "x".repeat(43) })).status).toBe(400);
    const tokens = (await (await token(exchange)).json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    expect(tokens.expires_in).toBe(3600);
    expect(JSON.stringify(tokens)).not.toContain(world.keyText.slice(12));
    // A code works once.
    expect((await token(exchange)).status).toBe(400);

    const mcp = new Client({ name: "claude-test", version: "1" });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(base), {
        requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } }
      })
    );
    const profile = (await mcp.callTool({ name: "business_profile", arguments: {} })) as {
      content: { text: string }[];
    };
    expect(JSON.parse(profile.content[0]!.text)).toMatchObject({
      businessName: "Marie Conseil",
      canInvoice: true
    });
    // Only what the merchant allows is listed (SPEC.md §16): its invoices, not the export.
    expect((await mcp.listTools()).tools.map(({ name }) => name)).toEqual([
      "business_profile",
      "preview_invoice",
      "create_invoice",
      "list_invoices",
      "invoice_status",
      "invoice_pdf",
      "invoice_card_pdf"
    ]);
    // The invoice card, served by the hosted server as by the local one (src/mcp/card.ts).
    const card = await mcp.readResource({ uri: "ui://sattleme/invoice-card.html" });
    expect(card.contents[0]).toMatchObject({ mimeType: "text/html;profile=mcp-app" });
    await mcp.close();

    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id
    });
    expect(refreshed.status).toBe(200);
    // An access token is not a refresh token.
    expect(
      (
        await token({
          grant_type: "refresh_token",
          refresh_token: tokens.access_token,
          client_id: client.client_id
        })
      ).status
    ).toBe(400);
  });

  it.each([
    [
      "ChatGPT",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "chatgpt.com",
      "https://chatgpt.com"
    ],
    [
      "a desktop app",
      "http://127.0.0.1:33418/callback",
      "une application de cet ordinateur (127.0.0.1:33418)",
      "http://127.0.0.1:33418"
    ],
    [
      "an app",
      "cursor://anysphere.cursor-retrieval/oauth/callback",
      "l&#39;application cursor:",
      "cursor:"
    ]
  ])("connects %s the same way, saying where the code goes", async (_, redirect, shown, action) => {
    const { client, verifier, page, html, answer } = await consent(world.keyText, redirect);
    expect(html).toContain(`vous revenez sur : <strong>${shown}</strong>`);
    expect(page.headers.get("content-security-policy")).toContain(`form-action 'self' ${action};`);
    expect(answer.status).toBe(302);
    const back = new URL(answer.headers.get("location")!);
    expect(back.href.startsWith(redirect)).toBe(true);
    const tokens = await token({
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: redirect
    });
    expect(tokens.status).toBe(200);
  });

  it("lets a desktop app come back on another port of its loopback address (RFC 8252)", async () => {
    const { answer } = await consent(
      world.keyText,
      "http://127.0.0.1:40000/callback",
      "http://127.0.0.1:33418/callback"
    );
    expect(answer.status).toBe(302);
    expect(answer.headers.get("location")!.startsWith("http://127.0.0.1:40000/callback?")).toBe(
      true
    );
  });

  it("can be limited to listed redirect URIs", async () => {
    const limited = createHostedApp({
      sealer: new Sealer(new Uint8Array(32).fill(42)),
      publicUrl: new URL("https://mcp.sattle.test"),
      allowedRedirects: CLAUDE_REDIRECTS,
      services: () => world.services(),
      timeZone: "Europe/Zurich",
      language: "fr",
      version: "0.0.0-test"
    });
    const server = await new Promise<Server>((resolve) => {
      const listening = limited.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}/register`;
    const post = (uri: string) =>
      fetch(at, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [uri], token_endpoint_auth_method: "none" })
      });
    expect((await post(REDIRECT)).status).toBe(201);
    expect((await post("https://chatgpt.com/connector_platform_oauth_redirect")).status).toBe(400);
    await new Promise((resolve) => server.close(resolve));
  });

  it("answers no MCP call without a valid token", async () => {
    const call = (authorization?: string) =>
      fetch(`${base}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(authorization ? { Authorization: authorization } : {})
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
    const none = await call();
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://mcp.sattle.test/.well-known/oauth-protected-resource"'
    );
    expect((await call("Bearer forged")).status).toBe(401);
    // A token of another purpose (a code) never opens as an access token.
    const { answer } = await consent(world.keyText);
    const code = new URL(answer.headers.get("location")!).searchParams.get("code")!;
    expect((await call(`Bearer ${code}`)).status).toBe(401);
    // An access token expires after an hour.
    const { client, verifier, answer: again } = await consent(world.keyText);
    const tokens = (await (
      await token({
        grant_type: "authorization_code",
        code: new URL(again.headers.get("location")!).searchParams.get("code")!,
        code_verifier: verifier,
        client_id: client.client_id,
        redirect_uri: REDIRECT
      })
    ).json()) as { access_token: string };
    expect((await call(`Bearer ${tokens.access_token}`)).status).toBe(200);
    offset = 3601;
    expect((await call(`Bearer ${tokens.access_token}`)).status).toBe(401);
  });

  it("writes nothing of a request it cannot read, nor answers with its own details", async () => {
    const written: string[] = [];
    const capture = (chunk: unknown) => {
      written.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stderr, "write").mockImplementation(capture);
    vi.spyOn(process.stdout, "write").mockImplementation(capture);
    for (const method of ["error", "warn", "log", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(" "));
      });
    }
    try {
      const post = (body: string) =>
        fetch(`${base}/`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream"
          },
          body
        });
      // A body cut short: Express would write it to the console, the client's name included.
      const cut = await post('{"jsonrpc": "2.0", "client": "Hans Muster, Bahnhofstrasse 1');
      expect(cut.status).toBe(400);
      expect(await cut.json()).toEqual({ error: "invalid_request" });
      const large = await post(JSON.stringify({ client: "Hans Muster ".repeat(30_000) }));
      expect(large.status).toBe(413);
      expect(await large.json()).toEqual({ error: "invalid_request" });
    } finally {
      vi.restoreAllMocks();
    }
    expect(written).toEqual([]);
  });
});

describe("who runs it, as its pages say", () => {
  /** Its pages at `origin`: the address's, the consent's, and the consent's after a wrong key. */
  async function pages(origin: string) {
    const server = createServer(
      createHostedApp({
        sealer: new Sealer(new Uint8Array(32).fill(9)),
        publicUrl: new URL(origin),
        allowedRedirects: null,
        services: () => world.services(),
        timeZone: "Europe/Zurich",
        language: "fr",
        version: "0.0.0-test"
      })
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const client = (await (
        await fetch(`${address}/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_name: "Claude",
            redirect_uris: [REDIRECT],
            token_endpoint_auth_method: "none"
          })
        })
      ).json()) as { client_id: string };
      const authorize = new URL(`${address}/authorize`);
      for (const [name, value] of Object.entries({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: createHash("sha256").update("verifier").digest("base64url"),
        code_challenge_method: "S256",
        resource: origin
      })) {
        authorize.searchParams.set(name, value);
      }
      const info = await (await fetch(`${address}/`, { headers: { Accept: "text/html" } })).text();
      const consent = await (await fetch(authorize)).text();
      const request = /name="request" value="([^"]+)"/.exec(consent)![1]!;
      const refused = await (
        await fetch(`${address}/consent`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form({ request, key: "nothing" })
        })
      ).text();
      return { info, consent, refused };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it("on mcp.sattle.me, is sattle.me's", async () => {
    const { info, consent, refused } = await pages("https://mcp.sattle.me");
    expect(info).toContain("L'application ouvre ensuite une page sattle.me");
    expect(info).toContain(
      'https://claude.ai/customize/connectors?modal=add-custom-connector&amp;connectorName=sattle.me&amp;connectorUrl=https%3A%2F%2Fmcp.sattle.me"'
    );
    for (const html of [info, consent, refused]) {
      expect(html).not.toContain("n&#39;est pas géré par sattle.me");
      expect(html).not.toContain("n'est pas géré par sattle.me");
    }
    expect(refused).toContain("Ce n&#39;est pas une clé d&#39;assistant");
  });

  it("self-hosted, never lets the merchant believe sattle.me runs it, on every page", async () => {
    const { info, consent, refused } = await pages("https://mcp.example.com");
    expect(info).toContain("L'application ouvre ensuite une page de ce serveur");
    expect(info).not.toContain("une page sattle.me");
    // Its connector is added under its own host, at its own address, never as sattle.me's alone.
    expect(info).toContain(
      "connectorName=sattle.me%20(mcp.example.com)&amp;connectorUrl=https%3A%2F%2Fmcp.example.com"
    );
    expect(info).not.toContain("connectorName=sattle.me&amp;");
    expect(info).toContain('<p class="address">https://mcp.example.com</p>');
    // Its warning comes before any button to add it.
    expect(info.indexOf("n'est pas géré par sattle.me")).toBeLessThan(
      info.indexOf("Ajouter à Claude")
    );
    for (const html of [info, consent, refused]) {
      expect(html).toContain("<strong>Ce serveur n'est pas géré par sattle.me.</strong>");
      expect(html).toContain("à l'adresse <strong>mcp.example.com</strong>");
      expect(html).toContain("Ne l'utilisez que si vous faites confiance à qui l'héberge.");
    }
    // Shown before the key is asked.
    expect(consent.indexOf("n'est pas géré par sattle.me")).toBeLessThan(
      consent.indexOf('name="key"')
    );
    expect(refused).toContain("Ce n&#39;est pas une clé d&#39;assistant");
  });

  it("is sattle.me's on its exact origin only", async () => {
    // A look-alike host, or another port of sattle.me's, is another server.
    for (const origin of ["https://mcp.sattle.me.example.com", "https://mcp.sattle.me:8443"]) {
      const { info } = await pages(origin);
      expect(info).toContain("n'est pas géré par sattle.me");
      expect(info).toContain(`<strong>${new URL(origin).host}</strong>`);
    }
  });
});

describe("OpenAI's domain verification", () => {
  /** The page /.well-known/openai-apps-challenge of a server given `challenge`. */
  async function challengePage(challenge: string | null) {
    const server = createServer(
      createHostedApp({
        sealer: new Sealer(new Uint8Array(32).fill(7)),
        publicUrl: new URL("https://mcp.sattle.test"),
        allowedRedirects: null,
        services: () => world.services(),
        timeZone: "Europe/Zurich",
        language: "fr",
        version: "0.0.0-test",
        openaiAppsChallenge: challenge
      })
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      return await fetch(`http://127.0.0.1:${port}/.well-known/openai-apps-challenge`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it("serves the token alone, as plain text, while the host sets it", async () => {
    const page = await challengePage("oai-7Kq_x.9");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toBe("oai-7Kq_x.9");
  });

  it("has no such page otherwise", async () => {
    expect((await challengePage(null)).status).toBe(404);
  });
});
