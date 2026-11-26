import { describe, expect, it } from "vitest";

import { redirectTarget, redirectsAllowed } from "../src/hosted/redirects.js";

/* Where an OAuth client of the hosted server may send the merchant back (src/hosted/redirects.ts). */

describe("a redirect URI", () => {
  it.each([
    ["https://claude.ai/api/mcp/auth_callback", "web", "claude.ai"],
    ["https://chatgpt.com/connector_platform_oauth_redirect", "web", "chatgpt.com"],
    ["http://localhost:8765/cb", "loopback", "localhost:8765"],
    ["http://[::1]:8765/cb", "loopback", "[::1]:8765"],
    ["vscode://vscode.github-authentication/did-authenticate", "app", "vscode:"],
    ["com.example.app:/oauth2redirect", "app", "com.example.app:"]
  ])("%s may be registered", (uri, kind, shown) => {
    expect(redirectTarget(uri)).toMatchObject({ kind, shown });
  });

  it.each([
    "http://example.com/cb",
    "http://10.0.0.2/cb",
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///etc/passwd",
    "googlechrome://evil.example",
    "intent://x#Intent;end",
    "bitcoin:bc1q",
    "https://a.example/cb#x",
    "https://u:p@a.example/cb",
    "https://a.example/c b",
    "not a url",
    `https://a.example/${"x".repeat(2100)}`,
    42
  ])("%s may not", (uri) => {
    expect(redirectTarget(uri)).toBeNull();
  });

  it("are 1 to 10 for a client, each allowed, and listed when the server lists them", () => {
    const ok = "https://claude.ai/api/mcp/auth_callback";
    expect(redirectsAllowed([ok], null)).toBe(true);
    expect(redirectsAllowed([], null)).toBe(false);
    expect(
      redirectsAllowed(
        Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`),
        null
      )
    ).toBe(false);
    expect(redirectsAllowed([ok], [ok])).toBe(true);
    expect(redirectsAllowed(["https://chatgpt.com/cb"], [ok])).toBe(false);
  });
});
