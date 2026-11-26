// The copy of sattleme/checkout-node this server builds on (vendor/checkout-node/): its `src/` and
// its tests' helpers, unchanged, at one commit (vendor/checkout-node/VENDOR.json, with the SHA-256
// of each file). They implement the rules this server shares with an integration's server (the
// relays, Nostr events and sealed records, NIP-44, the Lightning address, BOLT11, prices, the
// explorers): taken as they are, tested there, never edited here.
//
//   node scripts/vendor.mjs check
//       Whether vendor/checkout-node/ is VENDOR.json's, file for file (test/vendor.test.ts runs it).
//   node scripts/vendor.mjs import <checkout-node clone>
//       Replaces the copy with the files of a clean clone, at the commit it is on, and writes
//       VENDOR.json. Clone and check out the version yourself: no network.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY = "https://github.com/sattleme/checkout-node";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COPY = join(ROOT, "vendor", "checkout-node");
const PIN = "VENDOR.json";
/** What is copied, relative to the clone's root. */
const PARTS = ["src", "test/helpers", "LICENSE"];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Every file under `dir`, as paths relative to it with "/". */
function filesUnder(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(relative(dir, path).split(sep).join("/"));
    }
  };
  walk(dir);
  return found.sort();
}

/** The files of the copy, but VENDOR.json. */
function copied() {
  return filesUnder(COPY).filter((file) => file !== PIN);
}

/** Problems of the copy against VENDOR.json; none when it is the pinned commit's. */
export function checkVendor() {
  const problems = [];
  if (!existsSync(join(COPY, PIN))) return [`vendor/checkout-node/${PIN} is missing.`];
  const pin = JSON.parse(readFileSync(join(COPY, PIN), "utf8"));
  if (pin.repository !== REPOSITORY) problems.push(`${PIN}: not ${REPOSITORY}.`);
  if (!/^[0-9a-f]{40}$/.test(pin.commit ?? "")) problems.push(`${PIN}: no commit.`);
  const files = copied();
  for (const file of files) {
    if (!pin.files?.[file]) problems.push(`${file} is not in ${PIN}.`);
    else if (pin.files[file] !== sha256(join(COPY, file))) problems.push(`${file} was changed.`);
  }
  for (const file of Object.keys(pin.files ?? {})) {
    if (!files.includes(file)) problems.push(`${file} is in ${PIN}, not in the copy.`);
  }
  return problems;
}

function importFrom(clone) {
  const git = (...args) => execFileSync("git", ["-C", clone, ...args], { encoding: "utf8" }).trim();
  if (git("status", "--porcelain") !== "") throw new Error("The clone has local changes.");
  if (git("remote", "get-url", "origin").replace(/\.git$/, "") !== REPOSITORY) {
    throw new Error(`The clone is not ${REPOSITORY}.`);
  }
  const commit = git("rev-parse", "HEAD");
  rmSync(COPY, { recursive: true, force: true });
  for (const part of PARTS) cpSync(join(clone, part), join(COPY, part), { recursive: true });
  const files = Object.fromEntries(copied().map((file) => [file, sha256(join(COPY, file))]));
  writeFileSync(
    join(COPY, PIN),
    `${JSON.stringify({ repository: REPOSITORY, commit, files }, null, 2)}\n`
  );
  return commit;
}

const [command, argument] = process.argv.slice(2);
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (command === "check") {
    const problems = checkVendor();
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) process.exitCode = 1;
    else console.log("vendor/checkout-node/ is VENDOR.json's commit, file for file.");
  } else if (command === "import" && argument) {
    console.log(`vendor/checkout-node/ is checkout-node at ${importFrom(argument)}`);
  } else {
    console.error("Usage: node scripts/vendor.mjs check | import <checkout-node clone>");
    process.exitCode = 1;
  }
}
