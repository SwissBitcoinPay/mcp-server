#!/usr/bin/env node
// End-to-end checks against a running hosted assistant (a real deployment, or docker compose
// locally), as an AI app sees it before the merchant gives a key: health, HTTPS, the OAuth
// metadata, a client's registration, the consent page, the MCP endpoint refusing what has no token.
// It needs no key and changes nothing: a registered client is a sealed value the server keeps
// nowhere (docs/HOSTING.md).
//
//   node scripts/smoke.mjs https://mcp.sattle.me
//   NODE_EXTRA_CA_CERTS=<Caddy's root.crt> node scripts/smoke.mjs https://localhost
//
// Node 22 or later.
import { createHash, randomBytes } from "node:crypto";

const base = process.argv[2]?.replace(/\/+$/, "");
if (!base || !/^https?:\/\/[^/]+$/.test(base)) {
  console.error("usage: node scripts/smoke.mjs <origin, such as https://mcp.sattle.me>");
  process.exit(2);
}
const origin = new URL(base).origin;
const signal = () => AbortSignal.timeout(15_000);
const get = (path, init = {}) => fetch(`${origin}${path}`, { signal: signal(), ...init });
const json = (path, body) =>
  get(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
}
async function step(label, run) {
  try {
    await run();
  } catch (error) {
    check(label, false, error instanceof Error ? error.message : String(error));
  }
}

await step("health", async () => {
  const answer = await get("/health");
  check(
    "GET /health answers {ok: true}",
    answer.status === 200 && (await answer.json()).ok === true
  );
  check("no X-Powered-By", !answer.headers.has("x-powered-by"));
  if (origin.startsWith("https:")) {
    check(
      "HSTS",
      /max-age=\d{7,}/.test(answer.headers.get("strict-transport-security") ?? ""),
      answer.headers.get("strict-transport-security") ?? "none"
    );
  }
});

if (origin.startsWith("https:")) {
  await step("http redirects to https", async () => {
    const answer = await fetch(`http://${new URL(origin).host}/health`, {
      redirect: "manual",
      signal: signal()
    });
    check(
      "http:// redirects to https://",
      [301, 308].includes(answer.status) && answer.headers.get("location") === `${origin}/health`,
      `${answer.status} ${answer.headers.get("location")}`
    );
  });
}

let metadata;
await step("metadata", async () => {
  const resource = await (await get("/.well-known/oauth-protected-resource")).json();
  check("the resource is the origin", resource.resource === origin, resource.resource);
  check(
    "its authorization server is this origin",
    resource.authorization_servers?.includes(`${origin}/`),
    JSON.stringify(resource.authorization_servers)
  );
  metadata = await (await get("/.well-known/oauth-authorization-server")).json();
  check("the issuer is this origin", metadata.issuer === `${origin}/`, metadata.issuer);
  check("PKCE S256", metadata.code_challenge_methods_supported?.includes("S256"));
  check(
    "client ID metadata documents (CIMD) for public clients",
    metadata.client_id_metadata_document_supported === true &&
      metadata.token_endpoint_auth_methods_supported?.includes("none")
  );
  check(
    "the issuer in every authorization answer (RFC 9207)",
    metadata.authorization_response_iss_parameter_supported === true
  );
  check(
    "dynamic registration",
    metadata.registration_endpoint === `${origin}/register`,
    metadata.registration_endpoint
  );
});

let clientId;
const redirect = "http://127.0.0.1:33418/callback";
await step("registration", async () => {
  const answer = await json("/register", {
    client_name: "sattle.me smoke test",
    redirect_uris: [redirect],
    token_endpoint_auth_method: "none"
  });
  const client = await answer.json();
  clientId = client.client_id;
  check(
    "a client registers (loopback redirect)",
    answer.status === 201 && !!clientId,
    answer.status
  );
  const refused = await json("/register", {
    client_name: "smoke",
    redirect_uris: ["javascript:alert(1)"],
    token_endpoint_auth_method: "none"
  });
  check("a javascript: redirect is refused", refused.status === 400, refused.status);
});

await step("consent page", async () => {
  if (!clientId) throw new Error("no client registered");
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "smoke",
    scope: "invoices",
    resource: origin
  });
  const answer = await get(`/authorize?${query}`);
  const page = await answer.text();
  check("the consent page shows", answer.status === 200, answer.status);
  check(
    "it runs no script",
    (answer.headers.get("content-security-policy") ?? "").startsWith("default-src 'none'"),
    answer.headers.get("content-security-policy") ?? "no policy"
  );
  check("it asks the key on this server", page.includes('action="/consent"'));
  check("it is never cached", (answer.headers.get("cache-control") ?? "").includes("no-store"));
});

await step("MCP endpoint", async () => {
  const none = await json("/", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  check("no token: 401", none.status === 401, none.status);
  check(
    "it names its resource metadata",
    (none.headers.get("www-authenticate") ?? "").includes(
      `resource_metadata="${origin}/.well-known/oauth-protected-resource"`
    ),
    none.headers.get("www-authenticate") ?? "none"
  );
  const forged = await get("/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer forged"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  });
  check("a forged token: 401", forged.status === 401, forged.status);
  const broken = await json("/", '{"jsonrpc": "2.0", "cut');
  check(
    "a broken body: 400, nothing of it echoed",
    broken.status === 400 && (await broken.text()) === '{"error":"invalid_request"}',
    broken.status
  );
  const stream = await get("/", { headers: { Accept: "text/event-stream" } });
  check("GET / for a stream: 405 (stateless)", stream.status === 405, stream.status);
  const page = await get("/", { headers: { Accept: "text/html" } });
  check("GET / in a browser: a page saying what it is for", page.status === 200, page.status);
});

console.log(failures ? `${failures} check(s) failed` : "All checks passed");
process.exit(failures ? 1 : 0);
