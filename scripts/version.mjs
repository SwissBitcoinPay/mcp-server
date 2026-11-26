// The version of a release (docs/RELEASING.md): package.json, package-lock.json and manifest.json
// (the Claude Desktop bundle's) carry the same one, and CHANGELOG.md has a section named after it
// once it is released. Main carrying a version that has no tag yet, with its section, is what makes
// the release (.github/workflows/release.yml).
//
//   node scripts/version.mjs check
//       Whether the three files carry one version; prints it (CI runs it).
//   node scripts/version.mjs bump <x.y.z>
//       Writes <x.y.z> into the three files, and names CHANGELOG.md's « Unreleased » section after
//       it, dated today (UTC); a new, empty « Unreleased » section stays above it. Refused when the
//       version is lower than the current one, already has its section, or nothing is listed.
//   node scripts/version.mjs notes [<x.y.z>]
//       Prints CHANGELOG.md's section of that version (by default, the current one): the release's
//       notes. Fails when there is none.
//
// Only the version's own lines change: the files keep their formatting byte for byte.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** x.y.z, no leading zeros (Semantic Versioning, without pre-release nor build). */
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const UNRELEASED = "## Unreleased";

/** -1, 0 or 1 as `a` is lower than, equal to or greater than `b`. */
export function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

const read = (root, file) => readFileSync(join(root, file), "utf8");

/** The version each file carries. */
export function versions(root = ROOT) {
  const lock = JSON.parse(read(root, "package-lock.json"));
  return {
    "package.json": JSON.parse(read(root, "package.json")).version,
    "package-lock.json": lock.version,
    'package-lock.json packages[""]': lock.packages?.[""]?.version,
    "manifest.json": JSON.parse(read(root, "manifest.json")).version
  };
}

/** The one version the files carry; throws when they differ or it is not x.y.z. */
export function currentVersion(root = ROOT) {
  const found = versions(root);
  const distinct = [...new Set(Object.values(found))];
  if (distinct.length !== 1) {
    const list = Object.entries(found).map(([file, version]) => `${file}: ${version}`);
    throw new Error(`the files carry different versions (${list.join(", ")})`);
  }
  const [version] = distinct;
  if (typeof version !== "string" || !VERSION.test(version)) {
    throw new Error(`the version is not x.y.z: ${version}`);
  }
  return version;
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const heading = (version) => new RegExp(`^## ${escape(version)} \\(\\d{4}-\\d{2}-\\d{2}\\)$`, "m");

/** The body of CHANGELOG.md's section of `version`, or undefined when it has none. */
export function notes(changelog, version) {
  const match = heading(version).exec(changelog);
  if (!match) return undefined;
  const after = changelog.slice(match.index + match[0].length);
  const next = after.search(/^## /m);
  return (next === -1 ? after : after.slice(0, next)).trim();
}

/** Replaces the one line `pattern` matches in `text`, checking that it matches exactly once. */
function replaceOnce(text, pattern, replacement, what) {
  const count = [...text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].length;
  if (count !== 1) throw new Error(`${what}: expected its version line once, found ${count}`);
  return text.replace(pattern, replacement);
}

/** Writes `next` as the version, and names the « Unreleased » section after it on `date`. */
export function bump(next, { root = ROOT, date = new Date() } = {}) {
  if (!VERSION.test(next)) throw new Error(`not a version (x.y.z): ${next}`);
  const current = currentVersion(root);
  const changelog = read(root, "CHANGELOG.md");
  const order = compareVersions(next, current);
  if (order < 0) throw new Error(`${next} is lower than the current version, ${current}`);
  if (notes(changelog, next) !== undefined) {
    throw new Error(`CHANGELOG.md already has a section for ${next}`);
  }
  // Equal: the current version, never released, gets its section (a first release).

  const start = changelog.search(new RegExp(`^${escape(UNRELEASED)}$`, "m"));
  if (start === -1) throw new Error(`CHANGELOG.md has no "${UNRELEASED}" section`);
  const body = changelog.slice(start + UNRELEASED.length);
  const end = body.search(/^## /m);
  const listed = (end === -1 ? body : body.slice(0, end)).trim();
  if (listed === "") throw new Error(`nothing is listed under "${UNRELEASED}" in CHANGELOG.md`);
  const day = date.toISOString().slice(0, 10);
  const newChangelog =
    changelog.slice(0, start) +
    `${UNRELEASED}\n\n## ${next} (${day})\n\n${listed}\n` +
    (end === -1 ? "" : `\n${body.slice(end)}`);

  const updates = { "CHANGELOG.md": newChangelog };
  if (order > 0) {
    const was = escape(current);
    // The top-level "version" (two spaces of indent), and in the lockfile the root package's too.
    const top = new RegExp(`^(  "version": ")${was}(",?)$`, "m");
    updates["package.json"] = replaceOnce(
      read(root, "package.json"),
      top,
      `$1${next}$2`,
      "package.json"
    );
    let lock = replaceOnce(
      read(root, "package-lock.json"),
      top,
      `$1${next}$2`,
      "package-lock.json"
    );
    lock = replaceOnce(
      lock,
      new RegExp(`(\\n    "": \\{\\n(?:      .*\\n)*?      "version": ")${was}(",?\\n)`),
      `$1${next}$2`,
      'package-lock.json packages[""]'
    );
    updates["package-lock.json"] = lock;
    updates["manifest.json"] = replaceOnce(
      read(root, "manifest.json"),
      top,
      `$1${next}$2`,
      "manifest.json"
    );

    // Nothing but the versions changed.
    for (const file of ["package.json", "package-lock.json", "manifest.json"]) {
      const before = JSON.parse(read(root, file));
      const after = JSON.parse(updates[file]);
      after.version = before.version;
      if (file === "package-lock.json") after.packages[""].version = before.packages[""].version;
      if (!isDeepStrictEqual(before, after))
        throw new Error(`${file}: more than its version changed`);
    }
  }
  for (const [file, text] of Object.entries(updates)) writeFileSync(join(root, file), text);
  const result = currentVersion(root);
  if (result !== next) throw new Error(`the files carry ${result}, not ${next}`);
  return { from: current, to: next, files: Object.keys(updates) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, argument] = process.argv.slice(2);
  try {
    if (command === "check" && !argument) {
      console.log(currentVersion());
    } else if (command === "bump" && argument) {
      const { from, to, files } = bump(argument);
      console.log(`${from} → ${to}: ${files.join(", ")}`);
      console.log(
        `Next: commit "release: ${to}", open a pull request, merge it (docs/RELEASING.md).`
      );
    } else if (command === "notes") {
      const version = argument ?? currentVersion();
      const text = notes(read(ROOT, "CHANGELOG.md"), version);
      if (text === undefined) throw new Error(`CHANGELOG.md has no section for ${version}`);
      if (text === "") throw new Error(`CHANGELOG.md's section for ${version} is empty`);
      console.log(text);
    } else {
      console.error("Usage: node scripts/version.mjs check | bump <x.y.z> | notes [<x.y.z>]");
      process.exit(2);
    }
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
