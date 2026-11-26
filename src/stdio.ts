#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { Assistant } from "./assistant.js";
import { computerLanguage, computerPreferences } from "./locale.js";
import { createMcpServer, listAllowedTools } from "./mcp/tools.js";
import { isLanguage } from "./protocol/constants.js";
import { isTimeZone } from "./protocol/dates.js";

/*
 * The local server (SPEC.md §16): Claude Desktop (or any MCP client) starts it on the merchant's
 * computer and talks to it over stdio. Its settings come from the environment, which the client
 * fills from its configuration (manifest.json's user_config: the key, as a secret field, and the
 * folder; the bundle asks for no language nor time zone, the computer's are used):
 *
 *   SATTLEME_ASSISTANT_KEY   the assistant's secret key (sattleme_ak_…), required
 *   SATTLEME_PDF_DIRECTORY   where invoice_pdf and export_transactions also save their files
 *                            (default: nowhere)
 *   SATTLEME_LANGUAGE        the invoices' language when a call names none: fr, en, de, it, es, pt,
 *                            fi (default: the computer's, src/locale.ts; English when it is none
 *                            of these). For other MCP clients; the bundle never sets it.
 *   SATTLEME_TIME_ZONE       IANA time zone of the due dates (default: the computer's). The same.
 *
 * Nothing is written to stdout but the protocol; a failure to start says why on stderr, never the
 * key.
 */

const here = dirname(fileURLToPath(import.meta.url));

function version(): string {
  for (const path of [join(here, "..", "package.json"), join(here, "..", "..", "package.json")]) {
    try {
      const value = (JSON.parse(readFileSync(path, "utf8")) as { version?: unknown }).version;
      if (typeof value === "string") return value;
    } catch {
      // The other layout (src/ or dist/src/).
    }
  }
  return "0.0.0";
}

function fail(message: string): never {
  process.stderr.write(`sattle.me assistant: ${message}\n`);
  process.exit(1);
}

/** A setting, trimmed; unset when empty or left as the client's placeholder (`${user_config.x}`). */
function setting(name: string): string | null {
  const value = process.env[name]?.trim() ?? "";
  return value === "" || value.startsWith("${") ? null : value;
}

let assistant: Assistant;
try {
  assistant = new Assistant(setting("SATTLEME_ASSISTANT_KEY") ?? "");
} catch {
  fail("SATTLEME_ASSISTANT_KEY is not an assistant key (sattleme_ak_…): create one in the app");
}
const language = setting("SATTLEME_LANGUAGE") ?? computerLanguage();
if (!isLanguage(language)) fail("SATTLEME_LANGUAGE must be one of fr, en, de, it, es, pt, fi");
const timeZone = setting("SATTLEME_TIME_ZONE") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
if (!isTimeZone(timeZone)) fail("SATTLEME_TIME_ZONE is not a time zone (Europe/Zurich…)");
const pdfDirectory = setting("SATTLEME_PDF_DIRECTORY");

const server = createMcpServer(
  {
    assistant: () => assistant,
    timeZone,
    language,
    pdfDirectory,
    // The computer's languages: their region is the merchant's, on an invoice's PDF.
    preferences: computerPreferences()
  },
  version()
);
const transport = new StdioServerTransport();
await server.connect(transport);
// Only what the merchant allows this assistant is listed (SPEC.md §16).
listAllowedTools(server, transport, () => assistant.permissions());
