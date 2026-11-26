# Changelog

## Unreleased

## 1.0.0 (2026-11-26)

First public release.

- **Invoices from your AI app**: create sattle.me invoices with line items, VAT, a due date, a
  Bitcoin payment link and a PDF, numbered in the merchant's own series.
- **Payment tracking**: check whether an invoice is paid, over Lightning or on-chain, and list
  recent invoices.
- **One-message invoices**: when a message gives the client and every line, the invoice is made at
  once; otherwise it is previewed for the user to complete. An invoice already made is given back
  instead of being made again.
- **Invoice card**: in AI apps that support MCP Apps (Claude, ChatGPT…), an interactive card to
  complete, create and download the invoice in one click.
- **Accounting export**: the merchant's transactions over a period, as CSV or PDF, when the
  merchant allows it.
- **Multilingual**: invoices and PDFs in English, French, German (Germany and Switzerland),
  Italian, Spanish, Portuguese and Finnish.
- **Merchant control**: each assistant only gets the tools the merchant allowed in the sattle.me
  app; the server never spends funds.
- **Three ways to run it**: as a Claude Desktop extension (`.mcpb`), hosted with OAuth at
  `mcp.sattle.me`, or self-hosted with Docker, Render or `deploy/deploy.sh`.
- **Stateless and private**: no database and no key stored on the server; the assistant key is only
  held in memory for the request.
