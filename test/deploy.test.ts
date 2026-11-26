import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/*
 * deploy/deploy.sh on the deploying machine: it deploys a published release only (its tag on
 * GitHub's main, its package.json of that version), the very archive of that tag whatever is
 * checked out, never older than the version running unless asked, then checks the server runs it
 * and answers. ssh, curl and node are stand-ins that record what they are sent, and the server's
 * side (deploy/server-setup.sh) is a stand-in too.
 */
const HOST = "mcp.example.org";
const TARGET = "debian@192.0.2.10";
const pkg = (version: string) =>
  `{\n  "name": "@sattleme/mcp-server",\n  "version": "${version}",\n  "private": true\n}\n`;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A maintainer's machine: a clone whose origin (GitHub) has the releases v1.9.0 and v1.9.1 on main,
 * v9.0.0 on another branch only, and v2.0.0 whose package.json says another version; the checkout
 * has moved on past v1.9.1, with a change not even committed.
 */
function machine() {
  const dir = mkdtempSync(join(tmpdir(), "deploy-"));
  dirs.push(dir);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.org",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.org"
  };
  const repo = join(dir, "repo");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });
  mkdirSync(join(repo, "deploy"), { recursive: true });
  mkdirSync(join(repo, "scripts"), { recursive: true });
  copyFileSync("deploy/deploy.sh", join(repo, "deploy/deploy.sh"));
  writeFileSync(join(repo, "deploy/server-setup.sh"), "# the setup\n");
  const release = (version: string, packageVersion = version) => {
    writeFileSync(join(repo, "package.json"), pkg(packageVersion));
    writeFileSync(join(repo, "scripts/smoke.mjs"), `// v${version}'s checks\n`);
    git("add", ".");
    git("commit", "-q", "-m", `release: ${version}`);
    git("tag", `v${version}`);
    return git("rev-parse", "HEAD").trim();
  };
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", join(dir, "origin.git")], { env });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", join(dir, "origin.git"));
  const commits: Record<string, string> = {};
  commits["1.9.0"] = release("1.9.0");
  commits["1.9.1"] = release("1.9.1");
  commits["2.0.0"] = release("2.0.0", "1.9.2");
  git("switch", "-q", "-c", "side");
  commits["9.0.0"] = release("9.0.0");
  git("switch", "-q", "main");
  git("push", "-q", "origin", "main", "v1.9.0", "v1.9.1", "v2.0.0", "v9.0.0");
  // Only v1.9.1 is fetched by the script from origin: the clone forgets it.
  git("tag", "-d", "v1.9.1");
  // The checkout has moved on, and holds a change not committed.
  writeFileSync(join(repo, "scripts/smoke.mjs"), "// the checkout's\n");
  git("commit", "-q", "-am", "after the release");
  writeFileSync(join(repo, "deploy/server-setup.sh"), "# a change not committed\n");

  const bin = join(dir, "bin");
  mkdirSync(bin);
  const sent = join(dir, "sent");
  // ssh: the server. It records each call, answers the running release's package.json (FAKE_RUNNING
  // before the setup, FAKE_AFTER after it), keeps what it receives to unpack, and runs the setup as
  // FAKE_SETUP_STATUS says.
  writeFileSync(
    join(bin, "ssh"),
    `#!/bin/sh
printf '%s\\n' "$*" >>"${sent}.calls"
for last; do :; done
case "$last" in
  *"cat /opt/sattleme-mcp/current/package.json"*)
    [ -n "$FAKE_SSH_ERROR" ] && { echo "$FAKE_SSH_ERROR" >&2; exit 255; }
    if [ -f "${sent}.setup" ]; then printf '%s' "$FAKE_AFTER"; else printf '%s' "$FAKE_RUNNING"; fi ;;
  *"tar -x"*) cat >"${sent}.tar" ;;
  *server-setup.sh*) printf '%s\\n' "$last" >"${sent}.setup"; exit "\${FAKE_SETUP_STATUS:-0}" ;;
esac
`
  );
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh\nprintf '%s\\n' "$@" >"${sent}.curl"\nprintf '%s' "$FAKE_HEALTH"\n`
  );
  writeFileSync(
    join(bin, "node"),
    `#!/bin/sh\n{ cat "$1"; printf '%s\\n' "$@"; } >"${sent}.smoke"\nexit "\${FAKE_SMOKE_STATUS:-0}"\n`
  );
  for (const name of ["ssh", "curl", "node"]) chmodSync(join(bin, name), 0o755);

  /** Runs deploy/deploy.sh with `args` after the target and the host. */
  const deploy = (args: string[], extra: Record<string, string> = {}) => {
    for (const suffix of [".calls", ".tar", ".setup", ".curl", ".smoke"])
      rmSync(`${sent}${suffix}`, { force: true });
    const result = spawnSync("bash", ["deploy/deploy.sh", TARGET, HOST, ...args], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...env,
        FAKE_RUNNING: pkg("1.9.0"),
        FAKE_AFTER: pkg(args[0] ?? ""),
        FAKE_HEALTH: '{"ok":true}',
        ...extra,
        PATH: `${bin}:${process.env.PATH}`
      }
    });
    const read = (suffix: string) => {
      try {
        return readFileSync(`${sent}${suffix}`);
      } catch {
        return null;
      }
    };
    const lines = (suffix: string) => read(suffix)?.toString("utf8").trimEnd().split("\n") ?? null;
    return {
      ...result,
      calls: lines(".calls") ?? [],
      received: read(".tar"),
      setup: read(".setup")?.toString("utf8").trim() ?? null,
      curl: lines(".curl"),
      smoke: lines(".smoke")
    };
  };
  /** The archive of a commit, as the server must receive it. */
  const archive = (commit: string) =>
    execFileSync("git", ["archive", "--format=tar", commit], {
      cwd: repo,
      env,
      maxBuffer: 64 * 1024 * 1024
    });
  return { commits, deploy, archive };
}

describe("deploy/deploy.sh: a published release only", () => {
  it("deploys the very archive of the release's tag, not what is checked out", () => {
    const m = machine();
    const run = m.deploy(["1.9.1"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.received?.equals(m.archive(m.commits["1.9.1"] ?? ""))).toBe(true);
    expect(
      execFileSync("git", ["get-tar-commit-id"], {
        input: run.received?.subarray(0, 1024),
        encoding: "utf8"
      }).trim()
    ).toBe(m.commits["1.9.1"]);
    const rev = (m.commits["1.9.1"] ?? "").slice(0, 12);
    expect(run.setup).toMatch(
      new RegExp(
        `^sudo bash ~/\\.sattleme-mcp-upload/deploy/server-setup\\.sh --public-host mcp\\.example\\.org --release-name [0-9]{14}-${rev}; `
      )
    );
    expect(run.curl).toEqual(["-fsS", "--max-time", "10", `https://${HOST}/health`]);
    expect(run.stdout).toMatch(
      new RegExp(`Deployed v1\\.9\\.1 \\(${rev}\\) to https://mcp\\.example\\.org\\n$`)
    );
    // What changes since the version running, read from the tags.
    expect(run.stdout).toMatch(
      /== On the server: v1\.9\.0\n {3}What changes \(git diff v1\.9\.0 v1\.9\.1 to read it all\):\n {3}[0-9a-f]+ release: 1\.9\.1\n/
    );
  });

  it("passes the setup's options on", () => {
    const run = machine().deploy(["1.9.1", "--skip-dns-check"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.setup).toMatch(/ --skip-dns-check;/);
  });

  it("deploys onto a server with no release yet", () => {
    const run = machine().deploy(["1.9.1"], { FAKE_RUNNING: "" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/== On the server: no release yet/);
    expect(run.received).not.toBeNull();
  });

  it.each([
    ["is not x.y.z", "1.9", /the version is x\.y\.z/],
    ["is not a release on GitHub", "7.7.7", /could not fetch v7\.7\.7 from origin/],
    ["is a tag off main", "9.0.0", /v9\.0\.0 \([0-9a-f]{40}\) is not on GitHub's main/],
    [
      "is a tag whose package.json says another version",
      "2.0.0",
      /v2\.0\.0's package\.json is not version 2\.0\.0/
    ]
  ])("refuses a version that %s, before reaching the server", (_why, version, message) => {
    const run = machine().deploy([version]);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(message);
    expect(run.calls).toEqual([]);
  });

  it("asks for the version", () => {
    const run = machine().deploy([]);
    expect(run.status).toBe(2);
    expect(run.stdout).toMatch(/deploy\/deploy\.sh <admin@server> <public-host> <version>/);
    expect(run.calls).toEqual([]);
  });

  it("refuses an older version than the one running, and sends nothing", () => {
    const run = machine().deploy(["1.9.1"], { FAKE_RUNNING: pkg("1.10.0") });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(
      /v1\.9\.1 is older than v1\.10\.0, which runs on the server: to go back on purpose, add\n--allow-downgrade/
    );
    expect(run.received).toBeNull();
    expect(run.setup).toBeNull();
  });

  it("goes back to an older version with --allow-downgrade", () => {
    const run = machine().deploy(["1.9.1", "--allow-downgrade"], {
      FAKE_RUNNING: pkg("1.10.0")
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.received).not.toBeNull();
  });

  it("deploys the version running again", () => {
    const run = machine().deploy(["1.9.1"], { FAKE_RUNNING: pkg("1.9.1") });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).not.toMatch(/What changes/);
  });

  it("points to the provider's firewall when SSH fails, and sends nothing", () => {
    const run = machine().deploy(["1.9.1"], {
      FAKE_SSH_ERROR: "ssh: connect to host 192.0.2.10 port 22: Connection timed out"
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/SSH to debian@192\.0\.2\.10 failed \(its message above; /);
    expect(run.stderr).toMatch(
      /- connection timed out or refused: the provider's firewall does not let this machine's current\n {2}IPv4 address in on TCP 22;/
    );
    expect(run.stderr).toMatch(
      /- permission denied \(publickey\): .*\n.*\n.*IdentityFile of this host in ~\/\.ssh\/config/
    );
    expect(run.received).toBeNull();
  });

  it("fails when the setup fails", () => {
    const run = machine().deploy(["1.9.1"], { FAKE_SETUP_STATUS: "1" });
    expect(run.status).toBe(1);
    expect(run.curl).toBeNull();
  });

  it("fails when the server does not run the version after the setup", () => {
    const run = machine().deploy(["1.9.1"], { FAKE_AFTER: pkg("1.9.0") });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/the server does not run v1\.9\.1/);
    expect(run.curl).toBeNull();
  });

  it("fails when the server is not healthy from outside", () => {
    const run = machine().deploy(["1.9.1"], { FAKE_HEALTH: '{"ok":false}' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/https:\/\/mcp\.example\.org does not answer from here/);
  });

  it("--smoke runs the release's own scripts/smoke.mjs, not the checkout's", () => {
    const m = machine();
    const run = m.deploy(["1.9.1", "--smoke"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.smoke?.[0]).toBe("// v1.9.1's checks");
    expect(run.smoke?.[1]).toMatch(/\/smoke\.mjs$/);
    expect(run.smoke?.[2]).toBe(`https://${HOST}`);
    const failing = m.deploy(["1.9.1", "--smoke"], { FAKE_SMOKE_STATUS: "1" });
    expect(failing.status).toBe(1);
    expect(failing.stderr).toMatch(/scripts\/smoke\.mjs found the server failing/);
  });
});
