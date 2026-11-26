# sattle.me assistant (MCP server)

An [MCP](https://modelcontextprotocol.io) server that makes a [sattle.me](https://sattle.me)
merchant's invoices (numbered in the merchant's one series, with their lines and VAT, a payment
link payable until their due date and a PDF) and follows their payment, with the assistant's
secret key alone (`sattleme_ak_…`, created in the sattle.me app). It never spends: every invoice
pays the merchant's wallet.

Three ways to run it, one code:

- **In Claude Desktop**, on the merchant's own computer: the key never leaves it.
- **Hosted on `mcp.sattle.me`**, for any AI app that connects to MCP servers with OAuth (Claude,
  ChatGPT…).
- **Self-hosted**: the same server, run by anyone on a machine of their own (Docker).

Each version is published as a [GitHub release](https://github.com/sattleme/mcp-server/releases);
what changed is in [CHANGELOG.md](CHANGELOG.md).

| Path                                            | What it is                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`SPEC.md`](SPEC.md)                            | The assistant's protocol: what this server does with its key. Authoritative.          |
| [`vectors/app/`](vectors/app)                   | Records made by the merchant's app, which this server reads and makes alike.          |
| [`spec/`](spec)                                 | The integrations' specification (sattleme/checkout-spec), pinned: `SPEC.md` names it. |
| [`vendor/checkout-node/`](vendor/checkout-node) | The code of sattleme/checkout-node this server builds on, pinned and unchanged.       |

## In Claude Desktop

1. In the sattle.me app, create an assistant (« Intégrations › Créer une intégration › Assistant IA ») and copy its key
   (`sattleme_ak_…`).
2. Download `sattleme-assistant-<version>.mcpb` from the
   [latest release](https://github.com/sattleme/mcp-server/releases/latest) and open it: Claude
   Desktop installs it and asks for the key, which it keeps in the computer's secret store, and
   optionally a folder for the exports and the invoices' PDFs. The invoices' language and region
   (their numbers, German as Switzerland or Germany writes it) and the due dates' time zone are the
   computer's.
3. Ask Claude: « Invoice Dupont SA, rue du Lac 4, 1003 Lausanne, for 3 days of consulting at
   1,200 CHF excluding VAT, and give me the PDF. » Your message gives all it takes: it makes the invoice
   at once (due in 30 days when you name no due date) and gives its PDF. When a detail is missing
   (the client's address…), it previews the invoice for you to complete and make it.

Its tools: `business_profile`, `preview_invoice`, `create_invoice` (the only one that is not
read-only), `list_invoices`, `invoice_status`, `invoice_pdf`, `invoice_card_pdf` (the invoice
card's, below), and `export_transactions` (the
merchant's transactions of a period for the accountant, the app's CSV or PDF, only once the merchant
allowed it for this assistant in the app: « Intégrations », its line, « Autoriser l'export des
transactions »). The merchant chooses what each assistant may do when creating its key (its
invoices, for good; the export, at any time): an AI app is given only the tools allowed, as the
merchant's relays tell them when it asks the list (`SPEC.md` §16). Another MCP client starts
`node dist/src/stdio.js` with the settings of [`src/stdio.ts`](src/stdio.ts) in its environment.

Where the AI app shows MCP Apps (Claude, ChatGPT…), the preview and the invoice made come as an
**invoice card** in the conversation: the merchant completes there what is missing (the client's
address…), makes the invoice with its button, in one click, and saves its PDF, without a
download link. The card reaches no network (its sources in [`ui/`](ui),
[`src/mcp/card.ts`](src/mcp/card.ts)). The other AI apps get the same tools, in text.

With the card or without, an invoice like one made since its preview or in the last 24 hours (same
client's name, lines and texts) is given back instead of made again, however often the card is
shown or clicked, or the model asked; another one is made only once the user asks for it
(`SPEC.md` §16).

## Hosted

`https://mcp.sattle.me`, added in the AI app as a connector (a custom connector in Claude, a
custom MCP server in ChatGPT's Plugins; the address's page, opened in a browser, has a button for
each: Claude's fills in its dialog): the app asks the merchant to
connect, and the merchant pastes the assistant key on sattle.me's own page, never in the
conversation. How it is run: [docs/HOSTING.md](docs/HOSTING.md).

PDFs and exports come as download links of 15 minutes. For Claude to work with the files itself
(attach, store, print, convert them), allow the domain `mcp.sattle.me` once for its code execution:
Settings › Capabilities (in a Team or Enterprise organization, its owner). No server can do it for
the merchant; without it, Claude gives the link.

## Self-hosted

The hosted server on a machine of your own, for yourself or merchants who trust you with it: a
release of this repository, `docker compose up -d` (Caddy gets the HTTPS certificate), behind
your own reverse proxy, or on Render's free plan with one button (it sleeps when unused):

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/sattleme/mcp-server/tree/stable)
Whoever runs it sees the requests' keys and invoices in memory: see
[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) first.

## Development

Node 22 or later. `npm ci`, then `npm run check` (pinned copies, lint, format, types, tests, build).
`npm run bundle` writes the Claude Desktop bundle in `build/` (the official `mcpb` tool, pinned),
then starts it as Claude Desktop would. Releases and deployments:
[docs/RELEASING.md](docs/RELEASING.md).
The lockfile is written by npm 11 (`npx npm@11 install`): npm 10 installs from it (`npm ci`), but
fails to resolve it anew.

## License

[Apache License 2.0](LICENSE), Copyright 2026 Swiss Bitcoin Pay Sàrl ([NOTICE](NOTICE)). The
checkout SDK in `vendor/checkout-node` keeps its own [MIT License](vendor/checkout-node/LICENSE),
the fonts in `assets/fonts` the SIL Open Font License 1.1.

sattle.me and Swiss Bitcoin Pay are trademarks of Swiss Bitcoin Pay Sàrl. The license grants no
right to use them (its section 6): a fork or a modified version must not be presented under these
names or their logos, nor as made or endorsed by Swiss Bitcoin Pay Sàrl.
