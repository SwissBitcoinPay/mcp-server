import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error: a plain ES module of the repository's tooling, without types.
import * as versionModule from "../scripts/version.mjs";

const { bump, compareVersions, currentVersion, notes } = versionModule as {
  bump: (
    next: string,
    options: { root: string; date?: Date }
  ) => { from: string; to: string; files: string[] };
  compareVersions: (a: string, b: string) => number;
  currentVersion: (root?: string) => string;
  notes: (changelog: string, version: string) => string | undefined;
};

/*
 * A release's version (docs/RELEASING.md): package.json, package-lock.json and manifest.json carry
 * one, CHANGELOG.md names its section. `bump` changes nothing else, byte for byte.
 */
const FILES = ["package.json", "package-lock.json", "manifest.json"];
const roots: string[] = [];

function copy(changelog: string): string {
  const root = mkdtempSync(join(tmpdir(), "version-"));
  roots.push(root);
  for (const file of FILES) cpSync(file, join(root, file));
  writeFileSync(join(root, "CHANGELOG.md"), changelog);
  return root;
}
const text = (root: string, file: string) => readFileSync(join(root, file), "utf8");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CHANGELOG = `# Changelog

## Unreleased

- A new tool.
- A fix.

## 1.0.0 (2026-10-01)

- The first one.
`;

describe("the release's version", () => {
  it("is the same in package.json, package-lock.json and manifest.json", () => {
    expect(currentVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("compares as numbers, not as text", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.2.3", "1.10.0")).toBe(-1);
  });

  it("bump writes the version, and only it, and names the Unreleased section", () => {
    const root = copy(CHANGELOG);
    const before = Object.fromEntries(FILES.map((file) => [file, text(root, file)]));
    const current = currentVersion(root);
    const [major, minor] = current.split(".").map(Number);
    const next = `${major}.${(minor ?? 0) + 1}.0`;

    const result = bump(next, { root, date: new Date("2026-11-05T23:30:00Z") });
    expect(result).toEqual({ from: current, to: next, files: ["CHANGELOG.md", ...FILES] });
    expect(currentVersion(root)).toBe(next);
    for (const file of FILES) {
      // The same file with the version's lines changed: its formatting is kept.
      const changed = text(root, file).split("\n");
      const original = before[file]!.split("\n");
      expect(changed).toHaveLength(original.length);
      const differing = changed.filter((line, i) => line !== original[i]);
      expect(differing.length).toBe(file === "package-lock.json" ? 2 : 1);
      for (const line of differing) expect(line).toMatch(new RegExp(`^ +"version": "${next}",$`));
    }
    expect(text(root, "CHANGELOG.md")).toBe(`# Changelog

## Unreleased

## ${next} (2026-11-05)

- A new tool.
- A fix.

## 1.0.0 (2026-10-01)

- The first one.
`);
    expect(notes(text(root, "CHANGELOG.md"), next)).toBe("- A new tool.\n- A fix.");
  });

  it("bump to the current version names its section only (a first release)", () => {
    const root = copy("# Changelog\n\n## Unreleased\n\n- Everything.\n");
    const current = currentVersion(root);
    const before = Object.fromEntries(FILES.map((file) => [file, text(root, file)]));
    expect(bump(current, { root, date: new Date("2026-11-05T00:00:00Z") }).files).toEqual([
      "CHANGELOG.md"
    ]);
    for (const file of FILES) expect(text(root, file)).toBe(before[file]);
    expect(text(root, "CHANGELOG.md")).toBe(
      `# Changelog\n\n## Unreleased\n\n## ${current} (2026-11-05)\n\n- Everything.\n`
    );
  });

  it("bump refuses what would not make a sound release, changing nothing", () => {
    const current = currentVersion();
    const [major, minor, patch] = current.split(".").map(Number);
    const root = copy(CHANGELOG);
    const snapshot = () => [...FILES, "CHANGELOG.md"].map((file) => text(root, file));
    const before = snapshot();
    expect(() => bump("1.2", { root })).toThrow(/not a version/);
    expect(() => bump("01.2.3", { root })).toThrow(/not a version/);
    expect(() => bump("1.2.3-rc.1", { root })).toThrow(/not a version/);
    if (major! + minor! + patch! > 0) {
      expect(() => bump("0.0.0", { root })).toThrow(/lower than the current version/);
    }
    expect(snapshot()).toEqual(before);

    const empty = copy("# Changelog\n\n## Unreleased\n\n## 1.0.0 (2026-10-01)\n\n- One.\n");
    expect(() => bump(`${major}.${minor}.${patch! + 1}`, { root: empty })).toThrow(
      /nothing is listed/
    );
    const missing = copy("# Changelog\n\n- One.\n");
    expect(() => bump(`${major}.${minor}.${patch! + 1}`, { root: missing })).toThrow(
      /no "## Unreleased" section/
    );
    const released = copy(`# Changelog\n\n## Unreleased\n\n- Two.\n\n## ${current} (2026-10-01)\n`);
    expect(() => bump(current, { root: released })).toThrow(/already has a section/);
  });

  it("bump refuses files that carry different versions", () => {
    const root = copy(CHANGELOG);
    const manifest = text(root, "manifest.json").replace(
      /^ {2}"version": "[^"]+",$/m,
      '  "version": "9.9.9",'
    );
    writeFileSync(join(root, "manifest.json"), manifest);
    expect(() => currentVersion(root)).toThrow(/different versions/);
    expect(() => bump("10.0.0", { root })).toThrow(/different versions/);
  });

  it("notes are a version's own section, never a version that only starts alike", () => {
    const changelog =
      "## Unreleased\n\n## 1.0.10 (2026-11-05)\n\n- Ten.\n\n## 1.0.1 (2026-10-01)\n\n- One.\n";
    expect(notes(changelog, "1.0.1")).toBe("- One.");
    expect(notes(changelog, "1.0.10")).toBe("- Ten.");
    expect(notes(changelog, "1.0.0")).toBeUndefined();
  });

  it("the command line prints the version, and fails without a section", () => {
    const run = (...args: string[]) =>
      execFileSync("node", ["scripts/version.mjs", ...args], { encoding: "utf8", stdio: "pipe" });
    expect(run("check").trim()).toBe(currentVersion());
    expect(() => run("notes", "999.0.0")).toThrow(/no section for 999\.0\.0/);
  });
});
