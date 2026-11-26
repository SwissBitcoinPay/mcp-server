import { base64ToBytes, base64UrlToBytes } from "../../vendor/checkout-node/src/encoding.js";
import { isLanguage, type Language } from "../protocol/constants.js";
import { isTimeZone } from "../protocol/dates.js";

/*
 * The hosted server's settings, from its environment (docs/HOSTING.md, "Configuration"):
 *
 *   MCP_PUBLIC_URL          its public origin, https (https://mcp.sattle.me), required; on Render,
 *                           its onrender.com address when unset (RENDER_EXTERNAL_URL)
 *   MCP_SEAL_SECRET         32 random bytes or more, base64url (or standard base64, as Render
 *                           generates it), required: seals clients, codes and tokens (changing it
 *                           ends them all)
 *   PORT                    where it listens (8080)
 *   MCP_TIME_ZONE           due dates' time zone when a call names none (Europe/Zurich)
 *   MCP_LANGUAGE            invoices' language when a call names none (fr)
 *   MCP_TRUST_PROXY         reverse proxy hops to trust for the client's address (0)
 *   MCP_ALLOWED_REDIRECTS   only these redirect URIs, comma-separated (default: any AI app's)
 *   MCP_OPENAI_APPS_CHALLENGE  the token OpenAI's plugin portal shows to verify the domain, served
 *                           at /.well-known/openai-apps-challenge while set (none by default)
 *
 * A setting it cannot read stops it before it listens: it never runs on a guess.
 */

export type HostedSettings = {
  publicUrl: URL;
  secret: Uint8Array;
  port: number;
  timeZone: string;
  language: Language;
  trustProxy: number;
  allowedRedirects: string[] | null;
  openaiAppsChallenge: string | null;
};

/** What the server says when a setting is wrong (http.ts writes it and exits). */
export class SettingsError extends Error {}

/**
 * The seal secret's bytes: base64url (`deploy/`, the docs' command), or standard base64, padded or
 * not (Render's `generateValue`, render.yaml). The two alphabets differ only by `-_` against `+/`,
 * so a text valid in both decodes to the same bytes: a secret of either form keeps its meaning.
 */
export function secretBytes(text: string): Uint8Array | null {
  const padding = text.length % 4 === 0 ? "" : "=".repeat(4 - (text.length % 4));
  return base64UrlToBytes(text) ?? base64ToBytes(text + padding);
}

/** The settings of `env` (process.env), or a SettingsError naming the first one wrong. */
export function readHostedSettings(env: Record<string, string | undefined>): HostedSettings {
  // Render sets RENDER_EXTERNAL_URL to the service's own https://<name>.onrender.com address
  // (render.com/docs/environment-variables): a Deploy to Render button then needs no setting
  // typed by hand. An address set by its owner (a custom domain) prevails.
  const address = env.MCP_PUBLIC_URL || env.RENDER_EXTERNAL_URL || "";
  let publicUrl: URL;
  try {
    publicUrl = new URL(address);
  } catch {
    throw new SettingsError("MCP_PUBLIC_URL is not a URL");
  }
  if (publicUrl.protocol !== "https:" || publicUrl.pathname !== "/") {
    throw new SettingsError(
      "MCP_PUBLIC_URL must be an https origin, such as https://mcp.sattle.me"
    );
  }
  const secret = secretBytes(env.MCP_SEAL_SECRET ?? "");
  if (!secret || secret.length < 32) {
    throw new SettingsError("MCP_SEAL_SECRET must be 32 bytes or more, base64url");
  }
  const timeZone = env.MCP_TIME_ZONE || "Europe/Zurich";
  if (!isTimeZone(timeZone)) throw new SettingsError("MCP_TIME_ZONE is not a time zone");
  const language = env.MCP_LANGUAGE || "fr";
  if (!isLanguage(language)) {
    throw new SettingsError("MCP_LANGUAGE must be one of fr, en, de, it, es, pt, fi");
  }
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SettingsError("PORT is not a port");
  }
  const trustProxy = Number(env.MCP_TRUST_PROXY || 0);
  if (!Number.isInteger(trustProxy) || trustProxy < 0) {
    throw new SettingsError("MCP_TRUST_PROXY is not a number of hops");
  }
  const allowedRedirects = env.MCP_ALLOWED_REDIRECTS
    ? env.MCP_ALLOWED_REDIRECTS.split(",")
        .map((uri) => uri.trim())
        .filter(Boolean)
    : null;
  // Printable ASCII without spaces, as a token is: nothing else reaches the page.
  const openaiAppsChallenge = env.MCP_OPENAI_APPS_CHALLENGE || null;
  if (openaiAppsChallenge !== null && !/^[\x21-\x7e]{1,512}$/.test(openaiAppsChallenge)) {
    throw new SettingsError("MCP_OPENAI_APPS_CHALLENGE is not a token");
  }
  return {
    publicUrl,
    secret,
    port,
    timeZone,
    language,
    trustProxy,
    allowedRedirects,
    openaiAppsChallenge
  };
}
