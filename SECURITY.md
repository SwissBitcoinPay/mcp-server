# Security

This server makes a sattle.me merchant's invoices and follows their payment with the assistant's
secret key. A flaw here could let an attacker make an invoice that pays someone else, mark an
invoice paid that is not, give an invoice number twice, read a merchant's clients' data, or learn an
assistant's key: please report it **privately**, never in a public issue, pull request or discussion.

## How to report

- On GitHub: **Security** tab of this repository → **Report a vulnerability** (private
  vulnerability reporting).
- Or by email: security@sattle.me, subject starting with `[security] mcp-server`.

Please include what you found, the version, and, when you can, the steps or the input that show it.
Do not test against real merchants' funds, keys or data, nor against `mcp.sattle.me`.

We read reports in English. To encrypt an email, use the OpenPGP key of
security@sattle.me: [`.well-known/pgp-key.txt`](.well-known/pgp-key.txt), also served as
`/.well-known/pgp-key.txt`. Its fingerprint:
`578E F7BE 4E02 1431 1E63  C02A AFC1 E621 FAEF 5193`.

The same contact is served as [`/.well-known/security.txt`](.well-known/security.txt) (RFC 9116) by
the hosted server's Caddy.

## What is in scope

- This server, run in Claude Desktop, hosted or self-hosted, its release workflow and Claude
  Desktop bundle, and its protocol (`SPEC.md`). A self-hosted instance's own configuration is its
  operator's.

## What to expect

We will give you our assessment of your report within 10 days.

Please give us the time to fix and release before you disclose anything: we will agree on a date
with you, and credit you when the fix is published, unless you prefer otherwise. There is no reward
programme.
