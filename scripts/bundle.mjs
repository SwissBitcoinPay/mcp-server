// The Claude Desktop bundle (.mcpb, SPEC.md §16): the built server, its fonts, its production
// dependencies and manifest.json, packed by the official tool at a pinned version.
//
//   node scripts/bundle.mjs
//       Builds, stages build/bundle/, writes build/sattleme-assistant-<version>.mcpb, then checks
//       the file itself as Claude Desktop gets it (below).
//
// The dependencies are installed from package-lock.json (npm ci, without dev dependencies nor
// install scripts): the bundle holds exactly the versions the tests ran with. None is native: one
// bundle serves macOS, Windows and Linux.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STAGE = join(ROOT, "build", "bundle");
const MCPB = "@anthropic-ai/mcpb@2.1.2";

const run = (command, args, cwd = ROOT) =>
  execFileSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
if (manifest.version !== version) {
  throw new Error(`manifest.json is version ${manifest.version}, package.json ${version}`);
}

run("npm", ["run", "build"]);
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
for (const part of [
  "manifest.json",
  "package.json",
  "package-lock.json",
  "LICENSE",
  "NOTICE",
  // The vendored SDK's own license (MIT): its code is in dist/, NOTICE names this file.
  "vendor/checkout-node/LICENSE",
  "README.md",
  "dist",
  "assets"
]) {
  cpSync(join(ROOT, part), join(STAGE, part), { recursive: true });
}
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], STAGE);
run("npx", ["-y", MCPB, "validate", "manifest.json"], STAGE);
const out = join(ROOT, "build", `sattleme-assistant-${version}.mcpb`);
run("npx", ["-y", MCPB, "pack", STAGE, out]);

// The file as Claude Desktop gets it. The packing tool leaves files out by its own rules: unpacked
// away from this repository (no node_modules above it to hide a missing file), its server is
// started as manifest.json says and must answer over stdio; its tools are the manifest's; its
// invoice PDF (pdfkit, the fonts, the QR code) is made from its own files. The key is the app's
// test vector, whose relays are on relay.example, a name that never resolves (RFC 2606): the
// server lists the tools the merchant allows (SPEC.md §16), so its tools/list must answer that the
// relays cannot be read, which shows it read its key and tried them.
const unpacked = mkdtempSync(join(tmpdir(), "sattleme-bundle-"));
try {
  run("npx", ["-y", MCPB, "unpack", out, unpacked]);
  const vectors = JSON.parse(readFileSync(join(ROOT, "vectors", "app", "assistant.json"), "utf8"));
  const { serverInfo, listError, card } = await listTools(unpacked, vectors.secretKey);
  if (serverInfo.version !== version) {
    throw new Error(`the bundle's server says version ${serverInfo.version}, not ${version}`);
  }
  if (!listError?.message?.startsWith("network: ")) {
    throw new Error(
      `the bundle's server listed its tools unlike expected: ${JSON.stringify(listError)}`
    );
  }
  // Its tools: those of its own code, each with the permission that lists it (src/mcp/tools.ts).
  const toolsModule = pathToFileURL(join(unpacked, "dist", "src", "mcp", "tools.js"));
  const { TOOL_PERMISSIONS } = await import(toolsModule.href);
  const listed = Object.keys(TOOL_PERMISSIONS).sort();
  const declared = manifest.tools.map((tool) => tool.name).sort();
  if (JSON.stringify(listed) !== JSON.stringify(declared)) {
    throw new Error(`the bundle's server has tools ${listed}, manifest.json lists ${declared}`);
  }
  // The invoice card (src/mcp/card.ts), built into dist/ui/ and served from the bundle's files.
  if (
    card?.mimeType !== "text/html;profile=mcp-app" ||
    !card.text?.startsWith("<!doctype html>") ||
    !card.text.includes("<script>")
  ) {
    throw new Error("the bundle's server did not serve the invoice card");
  }
  const pdfModule = pathToFileURL(join(unpacked, "dist", "src", "pdf", "invoice-pdf.js"));
  const { invoicePdf } = await import(pdfModule.href);
  const pdf = await invoicePdf(
    vectors.invoice.value,
    { businessName: "Marie Conseil", invoicing: vectors.channel.value.invoicing },
    { language: "fr", timeZone: "Europe/Zurich" }
  );
  if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new Error("the bundle's server did not make a PDF");
  }
  console.log(
    `Checked: the bundle starts, answers over stdio, has the manifest's ${listed.length} tools, serves the invoice card and makes a PDF`
  );
} finally {
  rmSync(unpacked, { recursive: true, force: true });
}
console.log(`Written: ${out}`);

/**
 * Starts the unpacked bundle's server as manifest.json says, and asks its tools over stdio: its
 * information, the error its tools/list answers (null if it listed them), and the invoice card it
 * serves (resources/read, which reads no relay).
 */
function listTools(dir, key) {
  const config = manifest.server.mcp_config;
  const args = config.args.map((arg) => arg.replaceAll("${__dirname}", dir));
  const child = spawn(config.command, args, {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      SATTLEME_ASSISTANT_KEY: key
    },
    stdio: ["pipe", "pipe", "inherit"]
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("the bundle's server did not answer")), 30_000);
    const finish = (error, value) => {
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const send = (message) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    let serverInfo;
    let listError = null;
    let buffer = "";
    child.on("error", finish);
    child.on("exit", (code) => finish(new Error(`the bundle's server stopped (${code})`)));
    child.stdout.on("data", (data) => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (message.id === 1 && message.error) {
          return finish(new Error(`the bundle's server: ${message.error.message}`));
        }
        if (message.id === 3) {
          return finish(null, { serverInfo, listError, card: message.result?.contents?.[0] });
        }
        if (message.id === 1) {
          serverInfo = message.result.serverInfo;
          send({ method: "notifications/initialized" });
          send({ id: 2, method: "tools/list" });
        } else if (message.id === 2) {
          listError = message.error ?? null;
          send({
            id: 3,
            method: "resources/read",
            params: { uri: "ui://sattleme/invoice-card.html" }
          });
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "bundle-check", version }
      }
    });
  });
}
