import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { readHostedSettings, secretBytes, SettingsError } from "../src/hosted/settings.js";

/*
 * The hosted server's settings (src/hosted/settings.ts): what each variable accepts, the
 * defaults, and Render's own variables for a Deploy to Render button (render.yaml).
 */

const SECRET = randomBytes(32);
const BASE = {
  MCP_PUBLIC_URL: "https://mcp.example.com",
  MCP_SEAL_SECRET: SECRET.toString("base64url")
};

function refused(env: Record<string, string | undefined>): string {
  try {
    readHostedSettings(env);
  } catch (error) {
    expect(error).toBeInstanceOf(SettingsError);
    return (error as Error).message;
  }
  throw new Error("accepted");
}

describe("the hosted server's settings", () => {
  it("reads the two required ones and gives the defaults", () => {
    const settings = readHostedSettings(BASE);
    expect(settings.publicUrl.href).toBe("https://mcp.example.com/");
    expect(Buffer.from(settings.secret)).toEqual(SECRET);
    expect(settings).toMatchObject({
      port: 8080,
      timeZone: "Europe/Zurich",
      language: "fr",
      trustProxy: 0,
      allowedRedirects: null,
      openaiAppsChallenge: null
    });
  });

  it("reads the optional ones", () => {
    const settings = readHostedSettings({
      ...BASE,
      PORT: "10000",
      MCP_TIME_ZONE: "America/New_York",
      MCP_LANGUAGE: "de",
      MCP_TRUST_PROXY: "1",
      MCP_ALLOWED_REDIRECTS: " https://claude.ai/api/mcp/auth_callback , ,https://a.example/cb"
    });
    expect(settings).toMatchObject({
      port: 10000,
      timeZone: "America/New_York",
      language: "de",
      trustProxy: 1,
      allowedRedirects: ["https://claude.ai/api/mcp/auth_callback", "https://a.example/cb"]
    });
  });

  it("refuses an address that is not an https origin", () => {
    expect(refused({ ...BASE, MCP_PUBLIC_URL: undefined })).toMatch(/not a URL/);
    expect(refused({ ...BASE, MCP_PUBLIC_URL: "mcp.example.com" })).toMatch(/not a URL/);
    for (const url of ["http://mcp.example.com", "https://mcp.example.com/mcp"]) {
      expect(refused({ ...BASE, MCP_PUBLIC_URL: url })).toMatch(/https origin/);
    }
  });

  it("takes Render's own address when none is set, never over the one set", () => {
    const render = { MCP_SEAL_SECRET: BASE.MCP_SEAL_SECRET, RENDER: "true" };
    expect(
      readHostedSettings({ ...render, RENDER_EXTERNAL_URL: "https://sattleme-mcp.onrender.com" })
        .publicUrl.href
    ).toBe("https://sattleme-mcp.onrender.com/");
    expect(
      readHostedSettings({
        ...render,
        RENDER_EXTERNAL_URL: "https://sattleme-mcp.onrender.com",
        MCP_PUBLIC_URL: "https://mcp.example.com"
      }).publicUrl.href
    ).toBe("https://mcp.example.com/");
    expect(refused({ ...render, RENDER_EXTERNAL_URL: "" })).toMatch(/not a URL/);
    expect(refused({ ...render, RENDER_EXTERNAL_URL: "http://sattleme-mcp.onrender.com" })).toMatch(
      /https origin/
    );
  });

  it("refuses a secret shorter than 32 bytes or not base64", () => {
    for (const secret of [
      undefined,
      "",
      randomBytes(31).toString("base64url"),
      randomBytes(31).toString("base64"),
      "not base64!"
    ]) {
      expect(refused({ ...BASE, MCP_SEAL_SECRET: secret })).toMatch(/MCP_SEAL_SECRET/);
    }
  });

  it("reads OpenAI's domain token, a token only", () => {
    expect(
      readHostedSettings({ ...BASE, MCP_OPENAI_APPS_CHALLENGE: "oai-7Kq_x.9" }).openaiAppsChallenge
    ).toBe("oai-7Kq_x.9");
    for (const token of ["two words", "line\nbreak", "é", "x".repeat(513)]) {
      expect(refused({ ...BASE, MCP_OPENAI_APPS_CHALLENGE: token })).toMatch(
        /MCP_OPENAI_APPS_CHALLENGE/
      );
    }
  });

  it("refuses a time zone, a language, a port or proxy hops it cannot read", () => {
    expect(refused({ ...BASE, MCP_TIME_ZONE: "Mars/Olympus" })).toMatch(/MCP_TIME_ZONE/);
    expect(refused({ ...BASE, MCP_LANGUAGE: "nl" })).toMatch(/MCP_LANGUAGE/);
    for (const port of ["0", "65536", "80.5", "http"]) {
      expect(refused({ ...BASE, PORT: port })).toMatch(/PORT/);
    }
    for (const hops of ["-1", "1.5", "all"]) {
      expect(refused({ ...BASE, MCP_TRUST_PROXY: hops })).toMatch(/MCP_TRUST_PROXY/);
    }
  });
});

describe("the seal secret's text", () => {
  it("is base64url or standard base64, padded or not, to the same bytes", () => {
    // Bytes whose encodings use the characters that differ: `+/` against `-_`.
    const bytes = Buffer.from(Array.from({ length: 48 }, (_, i) => 0xf8 + (i % 8)));
    const standard = bytes.toString("base64");
    expect(standard).toMatch(/[+/]/);
    for (const text of [bytes.toString("base64url"), standard, standard.replace(/=+$/, "")]) {
      expect(Buffer.from(secretBytes(text) ?? [])).toEqual(bytes);
    }
    // 32 bytes: 43 characters, one `=` when padded (standard base64 of a 256-bit value).
    const key = randomBytes(32);
    expect(Buffer.from(secretBytes(key.toString("base64")) ?? [])).toEqual(key);
    expect(Buffer.from(secretBytes(key.toString("base64url")) ?? [])).toEqual(key);
  });

  it("refuses the two alphabets mixed, or a broken padding", () => {
    expect(secretBytes("ab-+abcd")).toBeNull();
    expect(secretBytes("abcde")).toBeNull();
    expect(secretBytes("abc==")).toBeNull();
    expect(secretBytes("ab=c")).toBeNull();
  });
});
