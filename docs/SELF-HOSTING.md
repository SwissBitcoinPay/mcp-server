# Self-hosting

Anyone can run the hosted server, the same code as `https://mcp.sattle.me`, on a machine of their
own: for themselves, or for merchants who trust them with it. Three ways: a server of your own with
Docker (option A), behind your own reverse proxy (option B), or Render's free plan with one button
(option C). AI apps then connect to its address
instead of sattle.me's. How the server works, what it stores (nothing) and what each setting means:
[HOSTING.md](HOSTING.md).

> Only using Claude Desktop on your own computer? You need none of this: install the bundle
> (`.mcpb`, [README](../README.md#in-claude-desktop)). The key then never leaves your computer.

## What you take on

- **You see what the merchants' requests hold.** Each request carries the merchant's assistant key
  (sealed in its token) and the server reads, in memory, the invoices it makes and follows: clients'
  names and addresses, amounts. Run it for yourself, or for merchants who accept that from you. A
  merchant who stops trusting your server removes the assistant in the sattle.me app: it stops at
  the very next request. Your server's pages tell merchants so before they paste a key: that
  sattle.me does not run it, its address, and what it sees (any origin but `https://mcp.sattle.me`).
- **One secret, `MCP_SEAL_SECRET`.** Whoever holds it can open the tokens, and the keys inside. It
  stays on the server, in a file only root (or you) reads, never in git nor in a backup. Changing it
  ends every connection: every merchant connects their AI app again.
- **One instance.** Never two replicas behind a load balancer (HOSTING.md, "One instance").
- **Reachable from the internet, over IPv4, with HTTPS.** Claude's connectors reach the server from
  Anthropic's servers, not from the merchant's computer, over IPv4 only, and refuse a name that
  resolves to a private address ([Claude's troubleshooting][claude-network]): a public DNS name with
  an `A` record, and a valid certificate. Any AI app that runs in the cloud (ChatGPT…) likewise
  reaches it from there.
- **Its updates.** Images are pinned (Node, Caddy): their security fixes come with this repository's
  releases. Update when one is published (below).

## Option A: a server of its own (HTTPS included)

The simplest: a machine where Docker runs (Docker Engine and its `compose` plugin), ports 80 and 443
open, and a DNS name pointing to it (`A` record). [Caddy](https://caddyserver.com) obtains and
renews the certificate (Let's Encrypt) and sits in front of the server, as on `mcp.sattle.me`.

```bash
git clone https://github.com/sattleme/mcp-server.git
```

```bash
cd mcp-server
```

Check out the latest release, `vX.Y.Z` as named on the
[releases page](https://github.com/sattleme/mcp-server/releases), rather than `main`:

```bash
git checkout vX.Y.Z
```

```bash
cp .env.example .env && chmod 600 .env
```

In `.env`, set `PUBLIC_HOST` to your DNS name (`mcp.example.com`, no `https://`) and
`MCP_SEAL_SECRET` to a new secret, which this command prints:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Without Node: `head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '='`. Then start it:

```bash
docker compose up -d --build
```

`https://mcp.example.com/health` answers `{"ok":true}` once Caddy has its certificate (a minute at
most). With Node 22, `node scripts/smoke.mjs https://mcp.example.com` checks what an AI app sees
before a merchant gives a key; it needs no key and changes nothing.

**A Debian 12/13 or Ubuntu 24.04/26.04 server, set up for you.** From your own computer,
`deploy/deploy.sh admin@<server> mcp.example.com X.Y.Z --smoke` installs Docker and the server,
makes the secret on the server (it never leaves it), allows SSH by key only, installs security
updates every day, restarts the server when its health check fails, and puts the previous release
back when a new one does not start: HOSTING.md, "Deploying it". It deploys the release `vX.Y.Z` as
published on GitHub, whatever is checked out on your computer.

## Option B: behind your own reverse proxy

Already running Nginx, Traefik or another proxy with its certificates: run the server alone,
listening on this machine only, and let the proxy forward to it.

Its settings, in a file only root reads (`/etc/sattleme-mcp/mcp.env`, say), never in git:

```bash
MCP_PUBLIC_URL=https://mcp.example.com
MCP_SEAL_SECRET=<the secret, made as in option A>
# The number of proxies in front of it (1: yours). The rate limits count per client address.
MCP_TRUST_PROXY=1
```

From the checked-out release (option A's first three commands), build the image and start it,
locked down as `docker-compose.yml` runs it:

```bash
docker build -t sattleme-mcp .
```

```bash
docker run -d --name sattleme-mcp --restart unless-stopped \
  --env-file /etc/sattleme-mcp/mcp.env \
  -p 127.0.0.1:8080:8080 \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  --stop-timeout 60 \
  sattleme-mcp
```

`-p 127.0.0.1:8080:8080` keeps the port on this machine: only the proxy reaches it. Whatever the
proxy, it must:

- serve HTTPS at an origin of its own (`https://mcp.example.com`, `MCP_PUBLIC_URL`) and forward
  every path of it to the server: the origin itself is the MCP endpoint, and the OAuth and consent
  pages are beside it;
- set `X-Forwarded-For` to the client's address (`MCP_TRUST_PROXY` is the number of proxies);
- not buffer answers: they stream (`text/event-stream`);
- log neither the requests' URLs (they hold OAuth values) nor their bodies (the consent page's
  holds the key) nor their `Authorization` header (a token sealing the key): no access log;
- preferably send `Strict-Transport-Security` (the consent page is where the key is pasted) and
  redirect `http://` to `https://`.

With Nginx (certificates from certbot, say):

```nginx
# sattle.me MCP server behind Nginx (docs/SELF-HOSTING.md). Replace mcp.example.com and the
# certificate's paths with yours.
server {
    listen 80;
    server_name mcp.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name mcp.example.com;
    ssl_certificate     /etc/letsencrypt/live/mcp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.example.com/privkey.pem;

    # No access log: a request's URL holds OAuth values, its Authorization header a token sealing
    # the merchant's assistant key. Never log bodies either (the consent's body is the key).
    access_log off;
    add_header Strict-Transport-Security "max-age=31536000" always;
    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        # Replaced, never appended: the server limits each client address (MCP_TRUST_PROXY=1).
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        # Answers stream as they come (text/event-stream).
        proxy_buffering off;
        proxy_read_timeout 120s;
    }
}
```

Watch its health from outside: `https://mcp.example.com/health`, `{"ok":true}`. Docker restarts the
container when it exits, not when it hangs (option A's `deploy/` adds a watchdog for that).

## Option C: Render's free plan, one button

No server of your own and nothing to install: [Render](https://render.com) builds this repository's
image and runs it at an address of its own, `https://<name>.onrender.com`, with its certificate.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/sattleme/mcp-server/tree/stable)

The button reads [`render.yaml`](../render.yaml) from the branch `stable`, the latest release
(`release.yml` moves it there once a release is published, never to unreleased code), and makes one
web service on the free plan, in Frankfurt. Render generates `MCP_SEAL_SECRET` itself (256 random
bits, never in git nor typed); the server takes its address from Render (`RENDER_EXTERNAL_URL`). Once
`https://<name>.onrender.com/health` answers `{"ok":true}`, the address merchants add is
`https://<name>.onrender.com`.

What the free plan means (render.com/docs/free, read on 06.11.2026):

- **It sleeps.** After 15 minutes without a request, Render stops it; the next request wakes it, in
  about a minute. An AI app's first call after a pause may fail or time out: calling again works.
  Not measured with Claude nor ChatGPT.
- **It may restart at any time**, and gets 750 free hours a month: one service running all month
  fits, a second one does not.
- **One instance**: the free plan never scales out, as this server needs.
- **Render is a company of its own (United States)**, here in its Frankfurt region: it runs the
  server, so it could see what the server sees in memory (the assistant keys in the requests, the
  invoices' clients). It shows its HTTP request logs (with the requests' paths) only from its Pro
  plan; whether it keeps them on the free plan is not documented. Use it for yourself, or for
  merchants who accept Render as well as you.
- **The rate limits per address** (HOSTING.md, "Limits") may count several clients as one: Render's
  proxies are not documented, so the server trusts one hop (`MCP_TRUST_PROXY=1`), the address no
  client can forge.
- Render may ask for a card at sign-up to verify the account (a hold of 1 USD, cancelled), even for
  the free plan.

**Updating**: the service does not follow new releases by itself (`autoDeployTrigger: off`). When a
release is published, in Render: the service › Manual Deploy › Deploy latest commit (the branch
`stable`). The secret and the address stay: no merchant connects again.

**A domain of your own**: add it to the service in Render, then set `MCP_PUBLIC_URL` to
`https://<your domain>` in its Environment. Clients and tokens are bound to the address: every
merchant connects their AI app again.

Not tested on a real Render account: `render.yaml` is checked against Render's published schema
(render.com/schema/render.yaml.json), and the server's reading of Render's variables by its tests
(`test/settings.test.ts`).

## Connecting an AI app

The address merchants add is the origin itself, `https://mcp.example.com` (no `/mcp`). In Claude:
« Customize › Connectors › Add custom connector » ([Claude's guide][claude-connector]); in
ChatGPT: as an app or connector. The AI app opens your server's page, where the merchant pastes the
assistant key (created in the sattle.me app: « Intégrations › Créer une intégration › Assistant
IA »), never in the conversation.

Running it for known AI apps only? `MCP_ALLOWED_REDIRECTS` limits where an authorization may go back
to (HOSTING.md, "Configuration"); `.env.example` shows Claude's.

## Updating

When a release is published (on GitHub: « Watch › Custom › Releases » tells you), check it out and
start again; the secret stays, so no merchant connects again, and a stop lets the requests in flight
finish (a minute at most):

```bash
git fetch --tags && git checkout vX.Y.Z
```

Option A:

```bash
docker compose up -d --build
```

Option B:

```bash
docker build -t sattleme-mcp . && docker stop sattleme-mcp && docker rm sattleme-mcp
```

then the same `docker run` as above.

## What to back up

Nothing but, if you wish, the secret: the server stores no key, no invoice and no client (they are
on the merchants' relays). Losing the secret only means every merchant connects their AI app again.

## Tested

With Docker 29, this repository's `Dockerfile`, `docker-compose.yml` and `Caddyfile`:
option A (`docker compose`, Caddy with its local certificate authority for `localhost`) and option
B (the `docker run` above behind the Nginx configuration above, Nginx 1.29) each passed
`scripts/smoke.mjs` in full; behind Nginx, a forged `X-Forwarded-For` did not escape the consent
page's rate limit. Every pull request builds the image and runs option A the same way (CI). Not
tested: a real public server and its Let's Encrypt certificate (option A's setup is
`mcp.sattle.me`'s), Traefik and other proxies.

[claude-network]: https://claude.com/docs/connectors/building/troubleshooting
[claude-connector]: https://claude.com/docs/connectors/custom/remote-mcp
