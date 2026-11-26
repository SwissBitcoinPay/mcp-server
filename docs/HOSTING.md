# Hosting mcp.sattle.me

The hosted version of the assistant (SPEC.md §16): an MCP server over Streamable HTTP for any AI
app that connects with OAuth (Claude, ChatGPT, IDEs…), at
`https://mcp.sattle.me` (the MCP endpoint is the origin itself). The same code as the local server; its entry is
[`src/http.ts`](../src/http.ts), its image the [`Dockerfile`](../Dockerfile).

Running your own instance of it: [SELF-HOSTING.md](SELF-HOSTING.md).

## How it works

- **Nothing is stored.** No database, no key on disk. A registered client is its `client_id` (its
  metadata, sealed); the merchant's consent, the authorization code and the tokens are sealed values
  (AES-256-GCM under keys derived from `MCP_SEAL_SECRET` and each value's purpose,
  [`src/hosted/seal.ts`](../src/hosted/seal.ts)). The assistant key travels inside them, which only
  this server opens, and lives in memory for one request. The tokens also seal the languages the
  merchant's browser prefers on the consent page (its `Accept-Language`, at most 8 tags): the
  region of its invoices' PDFs (SPEC.md §16).
- **OAuth 2.1** ([`src/hosted/provider.ts`](../src/hosted/provider.ts)), for any client in one of
  two ways, with redirect URIs as OAuth allows them
  ([`src/hosted/redirects.ts`](../src/hosted/redirects.ts)): https, http on a loopback address
  (desktop apps, any port, RFC 8252), or an app's own scheme; never `javascript:`, `data:`, another
  browser's scheme…
  - **Client ID metadata documents** (CIMD, [`src/hosted/cimd.ts`](../src/hosted/cimd.ts)), which
    Claude (its published client identity) and ChatGPT use first: the client_id is the
    https URL of the client's metadata, which the server reads (only from public addresses, no
    redirect followed, 5 kB and 5 s at most) and keeps as its `Cache-Control` says, a minute to a
    day. The consent page names the host of that URL, which the client proves by serving it.
  - **Dynamic client registration** (RFC 7591) otherwise: the client_id is its metadata, sealed.

  PKCE S256, resource indicators (RFC 8707), the issuer in every authorization answer (RFC 9207),
  access tokens of 1 hour, refresh tokens of 30 days. A code works once (remembered in memory until
  it expires) ([ChatGPT][openai], [Claude][claude]).

- **Consent** ([`src/hosted/consent.ts`](../src/hosted/consent.ts)): the merchant pastes the
  assistant key on the server's own page, never in the conversation. The page shows where the code
  goes back and who asks (the host of a client's metadata document; a registered client's name
  proves nothing: anyone can register one), runs no script (`Content-Security-Policy: default-src 'none'`), and checks the
  key against its channel before giving a code.
- **MCP**: stateless, one server and transport per request; the tools are the local server's
  except `invoice_pdf` and `export_transactions`, which give a download link instead of the file
  (AI apps do not all take a PDF in a tool's answer: Claude rejects it). The link,
  `/pdf/<token>/<file>` or `/export/<token>/<file>`, works 15 minutes: its token seals the key and
  what to make (purpose `pdf` or `export`), and the file is made again from the relays at each
  download, so the link stops as soon as the merchant removes the assistant or withdraws the
  export.
- **Files in the AI app**: the tool's answer tells the model to download the file itself when it
  works with it (attach it to a mail, store it, convert it), else to give the user the link. Its
  code sandbox reaches only the hosts the user allowed, once: in Claude, Settings › Capabilities
  (Team, Enterprise: the organization's owner), the domain `mcp.sattle.me`. No server can allow
  itself there; refused, the model tells the user, and the server's page at its address says it.
- **Limits**: 120 MCP requests a minute per IP, 60 per key, 20 consents a minute per IP; the
  SDK's own limits on registration and tokens. Bodies of 256 kB at most. Downloads: 120 a minute
  per IP (an AI app's sandboxes share their addresses), 30 PDFs and 10 exports per key.

## What stopping access means

- **The merchant removes the assistant in the app**: the very next call fails (`revoked`), every
  call reads the channel again. This is the way to cut access, for this server as for a local one.
- **The merchant removes the connector in the AI app**: the app forgets its tokens. A token copied
  before stays usable until it expires (1 hour, 30 days for a refresh token): stateless tokens
  cannot be revoked one by one. Removing the assistant in the app cuts them at once.
- **Changing `MCP_SEAL_SECRET`** ends every client and token at once: every merchant connects again.

## Configuration

| Variable                    | Meaning                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `MCP_PUBLIC_URL`            | `https://mcp.sattle.me` (an https origin), required (on Render, its `onrender.com` address when unset)          |
| `MCP_SEAL_SECRET`           | 32 random bytes or more, base64url (or standard base64), required; a secret of the host                         |
| `PORT`                      | 8080 by default                                                                                                 |
| `MCP_TIME_ZONE`             | due dates' time zone when a call names none (`Europe/Zurich`)                                                   |
| `MCP_LANGUAGE`              | invoices' language when a call names none (`fr`)                                                                |
| `MCP_TRUST_PROXY`           | reverse proxy hops before it (for the rate limits' client address)                                              |
| `MCP_ALLOWED_REDIRECTS`     | only these redirect URIs, comma-separated (default: any AI app's)                                               |
| `MCP_OPENAI_APPS_CHALLENGE` | OpenAI's domain token, served at `/.well-known/openai-apps-challenge` while set (ChatGPT's domain verification) |

`deploy/` makes the secret on the server and sets the others (`docker-compose.yml`:
`MCP_PUBLIC_URL` from the host's name, `MCP_TRUST_PROXY` 1 for Caddy); the optional ones go in
`/etc/sattleme-mcp/mcp.env`, then `sudo sattleme-mcp up -d`. Elsewhere, make the secret with
`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` and keep it in the
host's secret store only, never in git.

## Running it

[`docker-compose.yml`](../docker-compose.yml) runs it as it must run, behind Caddy
([`Caddyfile`](../Caddyfile)); [`deploy/`](../deploy) installs both on a server (below).

- **The address** is the origin itself: the MCP endpoint answers `POST /` (MCP sets no path), so
  merchants paste `https://mcp.sattle.me`. Its resource metadata (RFC 9728) is at
  `/.well-known/oauth-protected-resource` and names it without a trailing slash, the form MCP asks
  for. A browser opening it gets a page saying what it is for, and the version it runs. Once AI
  apps hold it, moving it disconnects every merchant.
- **One instance.** Invoices are made one at a time per key within a process (SPEC.md §17: a
  number and an address are taken from what the relays hold). Two instances could make two invoices
  of one assistant at the same second with the same address. Scale up, not out; or route every
  request of a key to one instance.
- **TLS** in front of it (Caddy, with Let's Encrypt), HTTP/1.1, 2 or 3; answers stream as they come
  (Caddy flushes `text/event-stream` at once).
- **No request logs**: the server writes its start, its stop and the kind of an internal error,
  never a request (not even one it cannot read: Express's own error handler would write its body).
  Caddy keeps no access log, and its errors while the server is down are answered without being
  logged. Behind another proxy: it must not log bodies nor the `Authorization` header (it holds the
  sealed key).
- **Stopping** (a deployment, `docker stop`) lets the requests in flight finish, up to a minute: an
  invoice cut between its number and its publication would leave a gap in the merchant's series
  (SPEC.md §13).
- **Health**: `GET /health`. **Logo**: `GET /icon.png` (512 px, named in the server's information),
  `/favicon.png` and `/favicon.ico` (48 px).
- **Network**: the server reaches the merchants' Nostr relays (WebSocket), their Lightning address
  (breez.tips), CoinGecko, mempool.space (or a merchant's own node), BlockCypher. They see its IP
  address, not the merchant's.

Elsewhere than with `deploy/`: `cp .env.example .env`, fill it in, `docker compose up -d`
([SELF-HOSTING.md](SELF-HOSTING.md), which also covers running it behind another reverse proxy).

## Where to run it

Recommended: **a small VPS of its own** (1 CPU and 2 GB are enough):

- **Load**: tens to hundreds of calls a day are nothing for it: about 110 MB of memory at rest,
  about 200 MB after twenty PDFs in a row, each made in about an eighth of a second; a call
  otherwise waits for the relays and services.
- **Isolation**: this server sees assistant keys in memory and holds `MCP_SEAL_SECRET`. On a
  machine of its own, a flaw in another service cannot reach it, and it restarts, updates and fills
  its disk on its own.

## Deploying it

[`deploy/`](../deploy) installs and updates the server on a Debian 12/13 or Ubuntu 24.04/26.04 VPS,
from your machine. The server needs nothing but SSH: no access to GitHub, no secret brought to it.

1. **Server**: the VPS, with your SSH key for its admin account (often `debian` or `ubuntu`). In
   the provider's firewall, let in TCP 80 and 443 and UDP 443 (HTTP/3) from everywhere, and TCP 22
   (SSH) from your own IP address only. Set a password for the admin account
   (`sudo passwd <admin>`): it only serves the provider's web console, the way back if SSH ever
   fails.
2. **DNS**: an `A` record for your host name (such as `mcp.example.com`) pointing to the server (an
   `AAAA` record only if the server has that IPv6 address), and preferably a `CAA` record allowing
   `letsencrypt.org` only. The script checks the `A`/`AAAA` records before Caddy asks for a
   certificate.
3. **Deploy** a release (its tag `v<version>` on GitHub's `main`), from this repository on your
   machine (git, ssh, curl; Node 22 for `--smoke`):

   ```bash
   deploy/deploy.sh admin@<server IPv4> mcp.example.com 1.0.0 --smoke
   ```

   Run the same command with a newer version to update ([RELEASING.md](RELEASING.md)): it deploys
   that release only, never an older one than the one running (unless `--allow-downgrade`),
   whatever is checked out on your machine. GitHub never reaches the server. `--smoke` then runs
   that release's [`scripts/smoke.mjs`](../scripts/smoke.mjs) against it: what an AI app sees
   before the merchant gives a key (HTTPS, the OAuth metadata, a registration, the consent page, the
   MCP endpoint refusing what has no token); it needs no key and changes nothing.

What [`deploy/server-setup.sh`](../deploy/server-setup.sh) sets up on the server, and checks before
it touches anything:

- **The secret**: `MCP_SEAL_SECRET` is made on the server at the first deployment, in
  `/etc/sattleme-mcp/mcp.env` (root only), and never leaves it: never shown, copied nor backed up.
  Nothing else is stored, so there is nothing to back up: on a new server, a new secret, and every
  merchant connects their AI app again (their assistants and invoices are on their relays, untouched).
  To change it on purpose (a suspected leak), replace its value in that file
  (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`), then
  `sudo sattleme-mcp up -d`: every connection ends at once.
- **SSH by key only, no root login**; refused if the admin account has no key (no lock-out).
- **Security updates** every day (`unattended-upgrades`), with a reboot at 04:30 UTC when one
  needs it; the server comes back with Docker.
- **Docker** from Docker's apt repository, its signing key checked against its fingerprint;
  bounded container logs.
- **The server and Caddy** (`docker-compose.yml`) from `/opt/sattleme-mcp/releases/<time>-<commit>`.
  If a new release does not start, or is not healthy within 3 minutes, the previous one is put back.
  The three latest releases are kept. Refused: a server already serving another name (AI apps
  registered for that one).
- **Watchdog** (`deploy/watchdog.sh`): every minute, restarts the server if its health check fails
  (Docker restarts a container that exits, not one that hangs).
- `sudo sattleme-mcp …`: `docker compose` for this project (`ps`, `logs mcp`, `logs caddy`).
- Two deployments never overlap.

**Watch it from outside**: an uptime monitor on `https://<your host>/health`, alerting you when it
fails. While it is down, AI apps cannot make invoices; the app, the payment links and the point of
sale do not depend on it.

[claude]: https://claude.com/docs/connectors/building/authentication
[openai]: https://developers.openai.com/apps-sdk/build/auth
