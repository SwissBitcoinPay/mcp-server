#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createHostedApp } from "./hosted/app.js";
import { hostedServices } from "./hosted/egress.js";
import { Sealer } from "./hosted/seal.js";
import { readHostedSettings, SettingsError, type HostedSettings } from "./hosted/settings.js";

/*
 * The hosted server's process (SPEC.md §16, docs/HOSTING.md). Its settings come from the
 * environment: src/hosted/settings.ts says which.
 *
 * Run one process: invoices are made one at a time per key within it (SPEC.md §17).
 */

function fail(message: string): never {
  process.stderr.write(`sattle.me hosted assistant: ${message}\n`);
  process.exit(1);
}

let settings: HostedSettings;
try {
  settings = readHostedSettings(process.env);
} catch (error) {
  if (error instanceof SettingsError) fail(error.message);
  throw error;
}
const {
  publicUrl,
  secret,
  port,
  timeZone,
  language,
  trustProxy,
  allowedRedirects,
  openaiAppsChallenge
} = settings;

// The release's version (package.json, docs/RELEASING.md): its page and its information name it,
// so a server that cannot read it does not start rather than show another.
function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // From src/ (one folder up) or from dist/src/ (two).
  for (const path of [join(here, "..", "package.json"), join(here, "..", "..", "package.json")]) {
    let found: unknown;
    try {
      found = (JSON.parse(readFileSync(path, "utf8")) as { version?: unknown }).version;
    } catch {
      continue; // The other layout.
    }
    if (typeof found === "string" && /^\d+\.\d+\.\d+$/.test(found)) return found;
    break;
  }
  fail("its version cannot be read from package.json");
}
const version = readVersion();

const app = createHostedApp({
  sealer: new Sealer(secret),
  publicUrl,
  allowedRedirects,
  services: () => hostedServices(),
  timeZone,
  language,
  version,
  trustProxy,
  openaiAppsChallenge
});
const server = app.listen(port, () => {
  process.stderr.write(`sattle.me hosted assistant ${version} on port ${port}\n`);
});

// A stop (a deployment, `docker stop`: SIGTERM) lets the requests in flight finish: an invoice cut
// between taking its number and publishing it would leave a gap in the merchant's series (SPEC.md
// §13). No new connection is taken meanwhile; a kept-alive connection closes as soon as its request
// is answered (checked every second: `close` alone closes only those idle when it is called, the
// proxy's others would hold the stop until their keep-alive timeout). In a container, Node runs as
// PID 1, which ignores SIGTERM without a handler: Docker would kill it after its grace period,
// mid-request.
let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    process.stderr.write("sattle.me hosted assistant stopped\n");
    process.exit(0);
  });
  server.closeIdleConnections();
  setInterval(() => server.closeIdleConnections(), 1000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
