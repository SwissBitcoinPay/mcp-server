// The invoice card (src/mcp/card.ts): ui/card.ts bundled with its dependencies (the official
// MCP Apps SDK, @modelcontextprotocol/ext-apps, pinned in package.json) by Vite, put inline in
// ui/card.html with the logo, written to dist/ui/invoice-card.html: one file, nothing to fetch.
//
//   node scripts/ui.mjs
//
// npm run build runs it after TypeScript; the tests run it first (vitest.config.ts).
import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist", "ui", "invoice-card.html");

const built = await build({
  configFile: false,
  root: ROOT,
  logLevel: "warn",
  build: {
    write: false,
    minify: true,
    target: "es2022",
    // Development is never shipped: the bundle is the same on every machine.
    sourcemap: false,
    lib: {
      entry: join(ROOT, "ui", "card.ts"),
      formats: ["iife"],
      name: "SattleMeInvoiceCard",
      fileName: () => "card.js"
    }
  }
});
const chunks = (Array.isArray(built) ? built : [built])
  .flatMap((result) => result.output)
  .filter((output) => output.type === "chunk");
if (chunks.length !== 1) throw new Error(`The card's script is ${chunks.length} files, not one`);
const script = chunks[0].code;

// Inline in a <script>: its text must not end the element.
const inline = script.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
const logo = readFileSync(join(ROOT, "assets", "favicon.png")).toString("base64");
const template = readFileSync(join(ROOT, "ui", "card.html"), "utf8");
for (const mark of ["__LOGO__", "__SCRIPT__"]) {
  if (template.split(mark).length !== 2) throw new Error(`ui/card.html must hold ${mark} once`);
}
const page = template
  .replace("__LOGO__", () => `data:image/png;base64,${logo}`)
  .replace("__SCRIPT__", () => `<script>${inline}</script>`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, page);
console.log(`${OUT}: ${Buffer.byteLength(page)} bytes`);
