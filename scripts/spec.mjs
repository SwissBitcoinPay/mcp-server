// The pinned copy of the specification (sattleme/checkout-spec, its PORTING.md: "The pinned
// copy of the specification"): spec/ holds the files its manifest.json lists, unchanged, and
// spec/PIN.json says which commit they come from, with the SHA-256 of each.
//
//   node scripts/spec.mjs check
//       Whether spec/ is PIN.json's, file for file (test/spec-pin.test.ts runs it too).
//   node scripts/spec.mjs import <checkout-spec clone>
//       Replaces spec/ with the files of a clean clone, at the commit it is on, and writes PIN.json.
//       Its manifest.json must be its files'. Clone and check out the version yourself: no network.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY = "https://github.com/sattleme/checkout-spec";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COPY = join(ROOT, "spec");
const PIN = "PIN.json";

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

/** What differs between spec/ and its PIN.json: empty when the copy is the pinned one. */
export function checkCopy(copy = COPY) {
  const pinPath = join(copy, PIN);
  if (!existsSync(pinPath)) return [`${PIN} is missing`];
  const pin = JSON.parse(readFileSync(pinPath, "utf8"));
  const problems = [];
  if (pin.repository !== REPOSITORY) problems.push(`${PIN}: repository is not ${REPOSITORY}`);
  if (!/^[0-9a-f]{40}$/.test(pin.commit ?? "")) problems.push(`${PIN}: commit is not a commit`);
  for (const [file, hash] of Object.entries(pin.files ?? {})) {
    const path = join(copy, file);
    if (!existsSync(path)) problems.push(`${file} is missing`);
    else if (sha256(path) !== hash) problems.push(`${file} differs from ${PIN}`);
  }
  for (const file of filesUnder(copy)) {
    if (file !== PIN && !(file in (pin.files ?? {}))) problems.push(`${file} is not in ${PIN}`);
  }
  return problems;
}

function importSpec(clone) {
  const git = (...args) => execFileSync("git", ["-C", clone, ...args], { encoding: "utf8" }).trim();
  if (git("status", "--porcelain") !== "") throw new Error(`${clone} is not clean`);
  const commit = git("rev-parse", "HEAD");
  const manifest = JSON.parse(readFileSync(join(clone, "manifest.json"), "utf8"));
  for (const [file, hash] of Object.entries(manifest.files)) {
    if (sha256(join(clone, file)) !== hash) throw new Error(`${file} is not the manifest's`);
  }
  rmSync(COPY, { recursive: true, force: true });
  for (const file of Object.keys(manifest.files)) {
    mkdirSync(dirname(join(COPY, file)), { recursive: true });
    cpSync(join(clone, file), join(COPY, file));
  }
  const pin = {
    repository: REPOSITORY,
    commit,
    version: manifest.version,
    protocol: manifest.protocol,
    files: manifest.files
  };
  writeFileSync(join(COPY, PIN), `${JSON.stringify(pin, null, 2)}\n`);
  return pin;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, clone] = process.argv.slice(2);
  if (command === "check") {
    const problems = checkCopy();
    for (const problem of problems) console.error(problem);
    process.exit(problems.length === 0 ? 0 : 1);
  } else if (command === "import" && clone) {
    const pin = importSpec(clone);
    console.log(`spec/ is checkout-spec ${pin.version} at ${pin.commit}`);
  } else {
    console.error("Usage: node scripts/spec.mjs check | import <checkout-spec clone>");
    process.exit(2);
  }
}
