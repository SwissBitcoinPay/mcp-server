# Releasing and deploying

Two steps, each started by a maintainer:

1. **Release**: the new version in a pull request; merging it makes the release (the tag
   `v<version>`, its GitHub release with the Claude Desktop bundle `.mcpb`). Nothing is deployed.
2. **Deploy**: from your machine, `deploy/deploy.sh <admin@server> <public-host> <version>` puts
   that release on your server, and nothing else: its tag on GitHub's `main`, whatever is checked
   out on your machine. GitHub never reaches the server.

## Versions

`x.y.z`, [Semantic Versioning](https://semver.org): `z` for fixes, `y` for what is added without
changing what merchants rely on (a new tool, a new option), `x` for a change merchants must act on
(a setting renamed, a tool removed). It is written in `package.json`, `package-lock.json` and
`manifest.json` (the bundle's, which Claude Desktop shows); `npm run version:check`, run by CI,
checks the three agree.

[`CHANGELOG.md`](../CHANGELOG.md): every pull request adds its lines under `## Unreleased`. A
release names that section after its version and date.

## Making a release

From an up-to-date `main`:

```bash
git switch main && git pull
git switch -c release/1.1.0
npm run version:bump -- 1.1.0
git commit -am "release: 1.1.0"
git push -u origin release/1.1.0
```

Then open the pull request and merge it once CI is green. `version:bump`
([`scripts/version.mjs`](../scripts/version.mjs)) writes the version into the three files, and
nothing else of them; it refuses a lower version, a version already in `CHANGELOG.md`, or an empty
`## Unreleased`.

On the merge, [`release.yml`](../.github/workflows/release.yml) releases `main` when its version has
no tag yet and `CHANGELOG.md` has its section; any other push to `main` releases nothing. It runs
every check, builds `sattleme-assistant-<version>.mcpb`, then tags that commit `v<version>` and
publishes the GitHub release with the bundle, its `SHA256SUMS` and the changelog's section as notes.
It then moves the branch `stable` to that commit (forward only), which the Deploy to Render button
deploys (`render.yaml`, SELF-HOSTING.md, option C), creating it when it does not exist yet. Only its
last job may write to the repository, and it runs no code of the repository nor of npm's packages.
If it fails, fix it on `main` with a pull request (the version, still untagged, is then released), or
run it again: Actions › Release › Run workflow.

Recommended, if your plan offers it, in the repository's Settings › General › Releases: **Enable
release immutability**. Once published, a release's tag and files can no longer be changed.

## Deploying

Releases are deployed from your machine, with the server's admin account, never from GitHub: GitHub
has no key, no secret and no workflow that reaches the server. The first deployment is described in
[HOSTING.md](HOSTING.md#deploying-it) (the server, its DNS record).

### Once: the provider's firewall

In the hosting provider's firewall for the server:

- TCP 80 and 443, and UDP 443 (HTTP/3): from everywhere, as AI apps reach the server;
- TCP 22 (SSH): **from your own IP address only**, the public address of your Internet access.

When your address changes, SSH no longer connects (`Connection timed out` or `refused`): change the
rule to your new address first. The provider's web console (the admin account's password,
[HOSTING.md](HOSTING.md#deploying-it)) is the way back in if you are locked out.

### Each time

1. **Release** the version (above) and wait for its GitHub release.
2. **Deploy it, from your machine**, from this repository (any branch, any state: the script
   fetches the tag):

   ```bash
   deploy/deploy.sh admin@<server IPv4> mcp.example.com 1.1.0 --smoke
   ```

   It fetches `v1.1.0` from GitHub, checks it is on `main` and that its `package.json` is that
   version, then asks the server which version runs: an older one than that is refused (see
   « Going back »), and the commits since are shown. The script then sends the tag's archive over
   one SSH connection, and the server ([`deploy/server-setup.sh`](../deploy/server-setup.sh), as
   root) brings the system up to date (packages, SSH, Docker, the watchdog), as at the
   installation, then installs and starts the release: a few minutes, the server building the
   image. A new release that does not start, or is not healthy within 3 minutes, is replaced by the
   previous one on its own.

3. The script then checks that the server runs that version, that `https://<public-host>/health`
   answers from your machine, and with `--smoke` runs that release's
   [`scripts/smoke.mjs`](../scripts/smoke.mjs) (Node 22 or later on your machine; it changes
   nothing).

Deploying the version that runs again is allowed (to repair a server).

**Going back to an older version** is refused unless you ask for it:

```bash
deploy/deploy.sh admin@<server IPv4> mcp.example.com 1.0.0 --allow-downgrade
```

### Your SSH key

The admin account's keys (`~/.ssh/authorized_keys` of that account on the server) are what deploys.
SSH offers `~/.ssh/id_ed25519` and its other default names only: if your key has another name, name
it for the server in `~/.ssh/config` on your machine (`deploy/deploy.sh` reads that file):

```
Host mcp.example.com <server IPv4>
  IdentityFile ~/.ssh/<your key file>
  IdentitiesOnly yes
```

### When it is refused

| The script says                                         | Why, and what to do                                                                                                                    |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `could not fetch v… from origin`                        | The version is not a published release (its tag is not on GitHub), or a local tag of that name differs: `git tag -d v…` and run again. |
| `v… is not on GitHub's main`                            | The tag is not on `main`: only releases of `main` are deployed.                                                                        |
| `v…'s package.json is not version …`                    | The tag does not carry that version: not a release made by the Release workflow.                                                       |
| `SSH to … failed` (`Connection timed out` or `refused`) | The provider's firewall does not let in your current IP address on TCP 22: update its rule, then run again.                            |
| `Permission denied (publickey)`                         | SSH offered no key the admin account takes: see « Your SSH key » above.                                                                |
| `v… is older than v…, which runs on the server`         | A downgrade: see « Going back » above.                                                                                                 |
| `another deployment is running on this server`          | Wait for it, then run again.                                                                                                           |
| `the new release is not healthy …; back to …`           | The previous release runs again. `sudo sattleme-mcp logs mcp` on the server says why.                                                  |
| `the server does not run v…`                            | The setup did not put that release in place: its message above.                                                                        |
| `https://… does not answer from here`                   | Check the DNS record and the provider's firewall (TCP 80 and 443); `sudo sattleme-mcp logs caddy` on the server.                       |

## Where the workflows run

Every job of CI, Release and security.txt runs on GitHub-hosted runners (`runs-on: ubuntu-24.04`),
a fresh virtual machine for each job, with the tools the jobs use (git, gh, curl, Docker, python3).
Do not add self-hosted runners: on a public repository, a fork's pull request would run its code on
them. No workflow deploys, nor holds anything that reaches a server.

CI runs on every pull request and every push to `main`: the checks on the latest Node 22, 24 and 26
(where the bundle and self-hosters run) and on `.nvmrc`'s exact version (the one the server's image
and the Release workflow run, so that a release never meets a failure the pull request did not), the
Claude Desktop bundle, and « Docker Compose », which builds the server's image and runs it with
Caddy as docs/SELF-HOSTING.md says. `.nvmrc` and the `Dockerfile`'s `node:` images name the same
version: change them together. Each job installs Node itself (actions/setup-node); the checks
install ShellCheck 0.11.0 themselves, pinned by its hash (`scripts/shellcheck.sh`).

## How it is protected

- **The way in.** The server's SSH port lets in your own IP address only (the provider's firewall),
  and the admin account takes keys only. GitHub has no key, no secret and no workflow that reaches
  the server.
- **What is deployed** is a published release only: its tag on GitHub's `main`, which the Release
  workflow makes once every check passed, and its `package.json` of that version, sent from your
  machine as `git archive` of that tag. A change on your machine, committed or not, is never
  deployed.
- **No going back by mistake**: an older version than the one running is refused unless
  `--allow-downgrade`.

`test/deploy.test.ts` runs `deploy/deploy.sh` with stand-ins for ssh, curl and node: the archive of
the tag is sent whatever is checked out; a version that is not x.y.z, not a release on GitHub, a tag
off `main` or a tag whose `package.json` says another version is refused before reaching the
server; an older version than the one running is refused unless `--allow-downgrade`; SSH's failure,
the setup's, a server not running the version afterwards, a failing `/health` or `smoke.mjs` stop
it.
