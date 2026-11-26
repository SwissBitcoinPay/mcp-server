import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The invoice card: an MCP App (the extension io.modelcontextprotocol/ui, version 2026-01-26) that
 * AI apps able to (Claude, ChatGPT…) show in the conversation for preview_invoice and
 * create_invoice, and that the others ignore: those tools answer the same text either way.
 *
 * It is one HTML page, built from ui/ by scripts/ui.mjs into dist/ui/ (the official SDK,
 * @modelcontextprotocol/ext-apps, bundled in it). It reaches no network: it declares no domain, so
 * the AI app gives it the extension's strictest content security policy (connect-src 'none'), and
 * everything it shows comes from this server's tools, which it calls through the AI app. The
 * invoice it makes is made by create_invoice, with the preview's previewedAt: once, whatever the
 * card is clicked (SPEC.md §16).
 */

/** The card's resource. */
export const CARD_URI = "ui://sattleme/invoice-card.html";

/** The extension's MIME type of an app's HTML (RESOURCE_MIME_TYPE of the SDK). */
export const CARD_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * The `_meta` of a tool that shows the card: the extension's key, and its former flat key, which
 * the SDK's registerAppTool also writes for the AI apps that read only that one.
 */
export const CARD_TOOL_META = { ui: { resourceUri: CARD_URI }, "ui/resourceUri": CARD_URI };

/** The `_meta` of a tool the card calls and the model does not see (visibility « app »). */
export const APP_ONLY_META = { ui: { visibility: ["app"] } };

/**
 * The card's `_meta` (the resource's and its contents'): no `csp`, so no domain is reached;
 * `prefersBorder`, so the AI app draws its own frame around it, as around its other cards.
 */
export const CARD_RESOURCE_META = { ui: { prefersBorder: true } };

const HERE = dirname(fileURLToPath(import.meta.url));

let html: string | null = null;

/**
 * The card's HTML: next to the server once built (dist/ui/, two folders up from dist/src/mcp/),
 * or in dist/ui/ when the server runs from its sources (the tests, which build it first).
 */
export function cardHtml(): string {
  if (html === null) {
    const file = [
      join(HERE, "..", "..", "ui", "invoice-card.html"),
      join(HERE, "..", "..", "dist", "ui", "invoice-card.html")
    ].find((path) => existsSync(path));
    if (file === undefined) throw new Error("The invoice card is missing: npm run build");
    html = readFileSync(file, "utf8");
  }
  return html;
}
