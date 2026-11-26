# sattle.me assistant: specification

Version 1 of the assistant's protocol. This document is for anyone who writes an **assistant**: a
program, such as this MCP server, that makes a sattle.me merchant's invoices (the invoices of the
app's « Nouvelle facture »: numbered, with their lines, their VAT and a payment link payable until
their due date) and follows their payment, with the assistant's secret key alone. It builds on the
integrations' specification, [spec/SPEC.md](spec/SPEC.md) (sattleme/checkout-spec, pinned in
[spec/PIN.json](spec/PIN.json)), whose rules it uses as they are where it names them: its
conventions, text, numbers, relay lists, key derivations, Nostr events, sealed records, relays,
HTTP, Lightning address, BOLT11, declarations, payment checks, prices and on-chain payments. This
document alone is authoritative for what it adds; the integrations' specification does not know of
assistants.

The key words MUST, MUST NOT, SHOULD and MAY are those of RFC 2119. Report any discrepancy as an
issue on [this repository](https://github.com/sattleme/mcp-server); a vulnerability, privately
([SECURITY.md](SECURITY.md)).

## Contents

1. [What an assistant does](#1-what-an-assistant-does)
2. [Conventions](#2-conventions)
3. [The assistant key](#3-the-assistant-key)
4. [Key derivations](#4-key-derivations)
5. [Reading the channel](#5-reading-the-channel)
6. [Numbers of invoices](#6-numbers-of-invoices)
7. [The invoice](#7-the-invoice)
8. [Amounts](#8-amounts)
9. [Points of the hour](#9-points-of-the-hour)
10. [On-chain addresses](#10-on-chain-addresses)
11. [The payment link](#11-the-payment-link)
12. [The link's record](#12-the-links-record)
13. [Making an invoice](#13-making-an-invoice)
14. [Reading the invoices](#14-reading-the-invoices)
15. [Following a payment](#15-following-a-payment)
16. [Two ways to run it](#16-two-ways-to-run-it)
17. [Security](#17-security)
18. [Constants](#18-constants)
19. [Conformance vectors](#19-conformance-vectors)
20. [Exporting the transactions](#20-exporting-the-transactions)

## 1. What an assistant does

The merchant creates an assistant in the sattle.me app and gives its **secret key**
(`sattleme_ak_…`) to the assistant. The assistant talks to the merchant's Nostr relays, the
merchant's Lightning address, CoinGecko and the block explorers, as an integration's server does
([spec/SPEC.md §1](spec/SPEC.md#1-what-an-integration-does)), and to nothing of sattle.me's but,
in its hosted version, the server that runs it ([§16](#16-two-ways-to-run-it)).

With that key alone, the assistant:

1. reads its **channel** ([§5](#5-reading-the-channel)): the merchant's business, Lightning address,
   registry and relays, what its invoices print, and how numbers are shared;
2. takes the next **number** of the merchant's one series of invoices, which the merchant's app and
   every assistant share ([§6](#6-numbers-of-invoices));
3. takes, when the merchant takes on-chain payments, a **deposit address** from the lot the app
   gives it ([§10](#10-on-chain-addresses));
4. publishes the invoice's **payment link** ([§11](#11-the-payment-link)), which the payer opens on
   the merchant's web app, and the link's **record** for the merchant's app
   ([§12](#12-the-links-record));
5. publishes the **invoice** ([§7](#7-the-invoice)), which the merchant's app lists among its own,
   « Par » naming the assistant;
6. **follows the payment** of its own invoices ([§15](#15-following-a-payment)) by the rule the
   merchant's app settles them with, as soon as the payments prove it, stating only what is proven;
7. **exports the merchant's transactions** of a period, as the merchant's app exports them, once
   the merchant allowed it for this assistant ([§20](#20-exporting-the-transactions)).

The merchant chooses what each assistant may do in the app, when it creates it: its **invoices**
(2 to 6), chosen then for good, and the **export** (7), allowed or withdrawn at any time. An
assistant created without invoices has a channel of version 2 ([§5](#5-reading-the-channel)): it
makes, reads and follows no invoice (`invoicing_not_allowed`), takes no number and no address.

The key never spends: every invoice pays the merchant's wallet. It reads no balance and no wallet,
and nothing the app made but what the merchant's grant of the export opens
([§20](#20-exporting-the-transactions)). The payer's page, not the assistant, asks the Lightning invoices and declares
them in the merchant's registry; the merchant's app writes the link's final version once the sale
is paid or ended, when the merchant opens it.

An assistant may live for one call: it keeps nothing between calls but what this document lets it
keep (nothing is required). Each call reads the channel again: a removal stops the very next
invoice.

## 2. Conventions

[spec/SPEC.md §2](spec/SPEC.md#2-conventions) (bytes, JSON, time, majority, HKDF, HMAC, base64),
[§6](spec/SPEC.md#6-text) (text), [§7](spec/SPEC.md#7-numbers) (numbers),
[§11](spec/SPEC.md#11-nostr-events) (events), [§12](spec/SPEC.md#12-sealed-records) (sealed
records) and [§13](spec/SPEC.md#13-relays) (relays) hold, with these differences, because the
merchant's app, which reads what an assistant writes, counts so:

- **Length** of the texts of an invoice ([§7](#7-the-invoice)) and of a payment link
  ([§11](#11-the-payment-link)) is counted in **UTF-16 code units** (a character above U+FFFF counts
  two). An assistant counts so, never fewer.
- **Blank**: a text is blank when it is empty once **ECMAScript whitespace** is removed from both
  ends (the list of [spec/SPEC.md §9](spec/SPEC.md#9-relay-lists), and line terminators U+000A,
  U+000D, U+2028, U+2029). Where this document asks for a text that is not blank, an assistant
  checks it so.
- **Padding**: an invoice's record is padded to a multiple of **1024** bytes; every other record
  of this document to a multiple of 256 ([spec/SPEC.md §12](spec/SPEC.md#12-sealed-records)).
- **Calendar dates** are `YYYY-MM-DD` of the proleptic Gregorian calendar, a year from 2000 to
  9999, a date that exists.
- **NIP-42**: a read or a write authenticates as the key this document names for it; a relay that
  gives an author's events to that author only answers the reads of other authors' records with
  `CLOSED`, and such a relay does not count as an answer.
- **Hours**: an hour is a Unix second that is a multiple of 3600 (HH:00:00 UTC).

## 3. The assistant key

```
sattleme_ak_<team>.<key>.<relays>
```

The prefix is `sattleme` for sattle.me and `ak` for assistant key. It is parsed as an integration
key is ([spec/SPEC.md §8](spec/SPEC.md#8-the-integration-key)), with this prefix in place of
`sattleme_ck_`: an integration key is not an assistant key, nor the reverse. A later format will
take another prefix (`sattleme_ak2_`), which an implementation of this version refuses.

- `<team>`: the team's public key, the author of the channel and of the lot.
- `<key>`: the **assistant key** (32 bytes).
- `<relays>`: the relays of the account when the key was made.

The key is a secret ([§17](#17-security)). Whoever holds it makes invoices in the merchant's name
(each pays the merchant), reads this assistant's invoices (its clients' names and addresses) and
takes numbers.

## 4. Key derivations

These never change: the merchant's app derives the same keys. `K` is the assistant key.

| Name                       | Derivation                                                          |
| -------------------------- | ------------------------------------------------------------------- |
| member secret              | HKDF(`K`, `sattle.me/team-member`, `nostr-secret-key/v1`)           |
| member key                 | hex(BIP-340 x-only public key of the member secret)                 |
| channel address (`d`)      | hex(HKDF(`K`, `sattle.me/team-member`, `channel/address/v1`))       |
| channel encryption key     | HKDF(`K`, `sattle.me/team-member`, `channel/encryption-key/v1`)     |
| records encryption key     | HKDF(`K`, `sattle.me/team-member`, `records/encryption-key/v1`)     |
| records address key        | HKDF(`K`, `sattle.me/team-member`, `records/address-key/v1`)        |
| links secret               | HKDF(`K`, `sattle.me/team-member`, `links/nostr-secret-key/v1`)     |
| links key                  | hex(BIP-340 x-only public key of the links secret)                  |
| taker key                  | HKDF(`K`, `sattle.me/declaration-taker`, `member/v1`)               |
| invoices secret            | HKDF(`K`, `sattle.me/assistant`, `invoices/author/v1`)              |
| invoices author            | hex(BIP-340 x-only public key of the invoices secret)               |
| invoices encryption key    | HKDF(`K`, `sattle.me/assistant`, `invoices/encryption-key/v1`)      |
| invoices address key       | HKDF(`K`, `sattle.me/assistant`, `invoices/address-key/v1`)         |
| record address of `s`      | hex(HMAC(records address key, UTF-8 of `s`))                        |
| lot address (`d`)          | record address of `onchain-lot`                                     |
| used address (`d`)         | record address of `onchain-used`                                    |
| invoice address of `id`    | hex(HMAC(invoices address key, UTF-8 of `invoice/<id>`))            |
| counter encryption key     | HKDF(counter key, `sattle.me/invoice-counter`, `encryption-key/v1`) |
| counter address (`d`)      | hex(HKDF(counter key, `sattle.me/invoice-counter`, `address/v1`))   |
| link record address of `a` | record address of `link:<a>` (`a`: the link's author, hex)          |
| export encryption key      | HKDF(`K`, `sattle.me/assistant`, `export/encryption-key/v1`)        |
| export address key         | HKDF(`K`, `sattle.me/assistant`, `export/address-key/v1`)           |

The counter key is the channel's ([§5](#5-reading-the-channel)). The secrets are used as
secp256k1 secret keys as they are (an HKDF output is a valid key but with negligible probability).
The merchant's app derives `K` from the team's root (`assistant/<id>/v1`): an assistant never
learns the root, an employee's key nor an integration's. The keys of a payment link's sale and its
taker tag are those of [§11](#11-the-payment-link).

Vectors: `vectors/app/assistant.json`, `derived` and `counter`.

## 5. Reading the channel

The channel is a sealed record of type `team-channel`, author the team, address the channel
address, key the channel encryption key, read as
[spec/SPEC.md §14](spec/SPEC.md#14-reading-the-channel) says (the lookup on a list, the newest valid
copy, the relay moves followed), with the member secret for NIP-42. Its valid value differs only
for an active channel:

- `status: "active"`, `role: "assistant"`;
- `name`: the assistant's name as the merchant typed it, a text that is not blank, at most 40 code
  units;
- `profile`: an object with `businessName` (not blank, at most 200 code units),
  `lightningAddress` (a valid Lightning address,
  [spec/SPEC.md §16](spec/SPEC.md#16-lightning-address)), `currency` (three letters `A–Z`) and
  `onchain` (a JSON boolean: whether the merchant takes on-chain payments); its other members are
  ignored;
- `registryKey`, `registryReader` and `linkOwner` hex32, the last two the x coordinate of a point
  of secp256k1;
- `linkKeyReader`: the x coordinate of a point of secp256k1 (hex32), the merchant's key the link
  secret is sealed for ([§12](#12-the-links-record)); absent or invalid: none, and the channel stays
  valid (an older merchant's app names none);
- `relays`: a valid relay list ([spec/SPEC.md §9](spec/SPEC.md#9-relay-lists));
- `onchainTolerance` and `bitcoinNode`: as [spec/SPEC.md §14](spec/SPEC.md#14-reading-the-channel)
  reads them (absent or invalid: none);
- `invoicing`: an object, valid as below; a channel of version 1 without a valid `invoicing` is
  not valid.

**Version 2** is the channel of an assistant the merchant created without invoices: an active
channel of version 1 with `version: 2` and no `invoicing` (one there is ignored). The assistant
makes, reads and follows no invoice, takes no number and no address: `invoicing_not_allowed`. A
removed channel is of version 1 only (one of version 2 is not valid). A value of a version above 2
is of a newer format (`newer`). The merchant's app writes an active channel in version 2 for such an
assistant only, every other in version 1: a reader of version 1 alone takes version 2 for a newer
format, and makes nothing.

`invoicing` holds:

- `businessAddress`: `null`, or an object whose `street`, `postalCode` and `city` are texts of at
  most 120 code units with no whitespace at either end (ECMAScript's), and whose `country` is `null`
  or two letters `A–Z` (ISO 3166-1 alpha-2);
- `companyNumber` and `vatNumber`: texts of at most 40 code units with no whitespace at either end,
  `""` when none;
- `detectedCountry`: `null` or two letters `A–Z`;
- `vatRate`: an integer from 0 to 10 000 (basis points: 810 is 8.1 %), the merchant's default;
- `linkOrigin`: `null`, or a checkout origin
  ([spec/SPEC.md §30](spec/SPEC.md#the-web-apps-origin)): the merchant's web app, where payment
  links open. `null`: the assistant makes no invoice (`no_web_app`);
- `counterKey`: hex32, the counter key;
- `counterWriters`: an array of at most 64 hex32 strings, each the x coordinate of a point of
  secp256k1, none twice: the invoices authors of the other writers of numbers
  ([§6](#6-numbers-of-invoices)).

Other members of the channel and of `invoicing` are the app's own and MUST be ignored. A channel
removed is `revoked`: the assistant makes no invoice, takes no number and no address. The
merchant's relays are the channel's `relays`.

Vectors: `vectors/app/assistant.json`, `channel`; `vectors/app/assistant-no-invoicing.json`,
`channel` (version 2).

## 6. Numbers of invoices

The merchant's invoices are numbered in **one series**, `YYYY-NNNN`: the year, and the rank in that
year, from 1, of at least four digits (`2026-0042`, `2026-12345`). The merchant's app and every
assistant share it. Each **writer** of numbers keeps a copy of the **counter**: a sealed record of
type `invoice-counter-shared`, author the writer's invoices author, key the counter encryption key,
address the counter address (the same address for every writer: each writer's own event there).
Its value:

- `version`: 1 (a number above 1: newer format);
- `year`: an integer from 2000 to 9999, the year of the last number the writer gave;
- `last`: an integer, 1 or more, the rank of that number.

Other members are ignored. The merchant's app also keeps a counter of its own that an assistant
cannot read; it writes its copy of the shared counter whenever it gives a number.

**Taking a number** for the year `Y` (the calendar's of the assistant, at the time):

1. Query `{"kinds": [30078], "authors": [<own invoices author>, <each of counterWriters>], "#d":
[<counter address>]}` on the merchant's relays, not paged, authenticating with the invoices secret.
   Fewer than a majority answered: `number`, no number is given.
2. For each writer (itself and each of `counterWriters`), open its events (author that writer) and
   keep its newest valid copy, as for the channel. A copy of a newer format at least as recent as a
   writer's newest valid one: `number`, no number is given (a newer writer's rule may differ).
3. The number is `Y` and one more than the highest `last` of the copies whose `year` is `Y` (and,
   where the assistant knows its own invoices of `Y`, above their ranks too); `1` when none.
4. Publish its own copy with that year and rank, dated after its own copy read (one second more,
   or now when later), to a majority of the merchant's relays, authenticating with the invoices
   secret ([spec/SPEC.md §13](spec/SPEC.md#13-relays), Publication). Fewer than a majority took it:
   `number`, the number is not used.

Only then is the number used. Two writers that take a number within the same seconds may take the
same: the merchant's app has the same limit between two of its devices. A number taken whose
invoice is never made leaves a gap. An assistant MUST never give a number it did not take so.

Vectors: `vectors/app/assistant.json`, `counter` (the owner's copy: the assistant's next number is
`next`).

## 7. The invoice

A sealed record of type `invoice`, author the invoices author, key the invoices encryption key,
address the invoice address of its `id`, padded to a multiple of **1024** bytes, dated by its
`updatedAt`. Its value, which the merchant's app reads (an assistant writes every member):

- `version`: 1 (a number above 1: newer format);
- `id`: 32 lowercase hex characters (16 random bytes from the CSPRNG);
- `number`: `{"year": Y, "sequence": N}`, the number taken ([§6](#6-numbers-of-invoices));
- `status`: `"sent"` (an assistant makes sent invoices only: the app ignores an assistant's draft);
- `recipient`: an object of `name`, `street`, `postalCode`, `city` (each a text that is not blank,
  at most 120 code units), `country` (two letters `A–Z`) and `reference` (a text of at most 120 code
  units, `""` when none);
- `currency`: `{"code": <three letters A–Z>, "digits": <0 to 4>}`: the merchant's currency, the
  channel's `profile.currency`, as the merchant's app invoices in the account's currency, and its
  digits in [spec/currencies.json](spec/currencies.json)
  ([spec/SPEC.md §25](spec/SPEC.md#25-prices-in-a-currency));
- `lines`: 1 to 50 lines ([§8](#8-amounts)), payable: their total is above 0 and at most the
  largest amount ([§8](#8-amounts));
- `dueDate`: a calendar date, from the day after today to the same day 9 months later (the month's
  last day when it has none); when the user names none, 30 days after today in the assistant's time
  zone (so that an invoice asked for in one message can be made at once), which `business_profile`
  tells as `defaultDueDate`; `dueAt`: the Unix second of the next midnight after `dueDate` in the
  assistant's time zone (the end of that day), after `sent.at`;
- `terms`, `legal`: texts of at most 1000 code units, `""` when none (the payment conditions, the
  legal notice);
- `redirectUrl`: `null`, or an `https` URL of at most 500 code units with a host, where the payer's
  page offers to go once paid;
- `createdAt`, `updatedAt`: Unix seconds, `updatedAt` ≥ `createdAt`;
- `sent`: `{"at": <Unix seconds>, "link": {"id": <the link's author, hex32>, "key": <the sale key,
hex32>, "relays": <the link's relays>, "url": <the link's URL, at most 2000 code units>}}`
  ([§11](#11-the-payment-link)).

A record of the invoices author whose value has `removed: true` is a removed draft, and anything
else the app does not read is not an invoice: neither is listed. An assistant MUST NOT write any
other record under its invoices author than its invoices and its copy of the counter.

Vectors: `vectors/app/assistant.json`, `invoice`.

## 8. Amounts

Every amount is an integer ([spec/SPEC.md §7](spec/SPEC.md#7-numbers)). A **line** is:

- `name`: a text that is not blank, at most 120 code units;
- `quantity`: hundredths of a unit, an integer from 1 to 9 999 999 (99 999.99 units);
- `unitMinor`: the price of one unit before VAT, in minor units of the invoice's currency, an
  integer from 0 to the largest amount;
- `vatRate`: basis points, an integer from 0 to 10 000.

The **largest amount** is 99 999 major units and all their decimals: `99 999 × 10^d + 10^d − 1`
minor units for a currency of `d` digits (99 999.99 for 2).

A line's amount before VAT is `round(quantity × unitMinor / 100)`, half up. The **totals**:

- `netMinor`: the sum of the lines' amounts;
- `vat`: for each rate above 0, lowest first, `{"rate", "baseMinor", "vatMinor"}`: the sum of that
  rate's lines' amounts, and its tax `round(baseMinor × rate / 10 000)`, half up;
- `totalMinor`: `netMinor` plus every rate's tax.

Half up: `round(a / b)` = `floor((2a + b) / (2b))` for `a ≥ 0`, `b > 0`. The payment link asks the
invoice's `totalMinor` ([§11](#11-the-payment-link)).

An assistant that takes amounts as text (from a person or a model) reads them as decimals, never
as floating-point numbers, and refuses more digits after the separator than the field has (the
currency's digits for a price, 2 for a quantity, 2 for a VAT rate in percent): it never rounds what
it was given.

Vectors: `vectors/app/assistant.json`, `invoice.totals`.

## 9. Points of the hour

A payment link is priced hour by hour, as the merchant's app prices every sale: the amount due in
sats is the invoice's total at the **point** of an hour, rounded up to the next whole sat, without
margin. A point is CoinGecko's price of one bitcoin in the currency at an exact hour, which anyone
can read again later to the same digits.

- **The hour of a time** `t` (Unix seconds) is the hour of the point that prices it:
  `pointHour(t) = floor((t − 300) / 3600) × 3600`. From 14:05:00 to 15:04:59 UTC, the point of
  14:00. Its period ends at `pointEnd(h) = h + 3900`.
- **Reading points**: `GET https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=<code>&days=1`
  (the 5-minute series of the last day) or
  `GET https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range?vs_currency=<code>&from=<s>&to=<s>`
  (hourly points), `<code>` the currency's code in lower case, through
  [spec/SPEC.md §15](spec/SPEC.md#15-http). The answer is an object whose `prices` is an array; each
  entry `[ms, price]` whose `ms` is a multiple of 3 600 000 and whose `price` is a finite JSON number
  above 0 is the point of the hour `ms / 1000`; other entries are ignored, and so is the last entry
  of the 5-minute series (the live price, at any second). Anything else is a failure.
- **Which series**: for an hour `h` of the last day (`h > now − 82 800`), the 5-minute series, then,
  once `now − h ≥ 900`, the hourly windows `[now − 86 400, now]` and `[now − 172 800, now]`, in turn
  until one holds it; for an older hour, the window `[h − 43 200, h + 43 200]`. Several hours: windows
  of at most 89 days. CoinGecko keeps 365 days without key; a point it does not give (not published
  yet, too old) is **unknown**, never zero.
- **The amount due** at a point: [spec/SPEC.md §25](spec/SPEC.md#25-prices-in-a-currency), the
  point read as a JSON number, `minor` the invoice's `totalMinor` and `digits` its currency's:
  `sats = ceil(minor × 10^8 × 10^scale / (units × 10^digits))`.

## 10. On-chain addresses

When the channel's `profile.onchain` is true, an invoice MAY offer a **deposit address**
([spec/SPEC.md §31](spec/SPEC.md#deposit-addresses)), taken from the assistant's **lot**: a sealed
record of type `team-onchain-lot`, author the team, key the channel encryption key, address the lot
address. Its valid value:

- `version`: 1 or 2 (a number above 2: newer format, the lot is empty);
- `addresses`: deposit addresses, none twice: 0 to 20 in version 1, 0 to 100 in version 2 (the
  merchant's app writes an assistant's lot in version 2, with up to 100 addresses);
- `tags`: as many tags, each 16 lowercase hex characters: the merchant's tag of the address of the
  same rank;
- `updatedAt`: the event's `created_at`.

The addresses the assistant **used** are its record of type `team-onchain-used`, author the member
key, key the records encryption key, address the used address, value `{"version": <the version of
the lot read>, "used": [<deposit addresses of the lot, none twice, at most as many as its version
holds>], "lotAt": <the updatedAt of the lot read>, "updatedAt": <its created_at>}`. A used record
of version 1 is read with at most 20 addresses, of version 2 with at most 100; a number above 2 is
of a newer format.

**Taking an address**:

1. Read the lot (authenticating with the member secret) and the used record (likewise) on the
   merchant's relays, not paged; fewer than a majority answered: none is taken. The newest copy
   of each counts: a lot whose newest copy is of a newer format is empty (never an older copy a
   relay still holds); a used record whose newest copy is of a newer format: none is taken, and
   that record is never written over.
2. The candidates are the lot's addresses not in `used`, in the lot's order.
3. For the first candidate, ask the explorer ([spec/SPEC.md §31](spec/SPEC.md#explorers):
   mempool.space, or the channel's `bitcoinNode`) whether anything ever paid it. Paid: add it to
   `used` and try the next. The explorer silent: none is taken (and none added to `used` for it:
   an outage would empty the lot).
4. Publish the used record, `used` being the previous `used` still in the lot, those found paid
   and the address taken, `lotAt` the lot's `updatedAt`, dated after the previous used record (one
   second more, or now when later), on a majority of the relays. Fewer than a majority took it:
   none is taken.

No candidate left: the invoice offers no address (and must then fit Lightning's bounds,
[§13](#13-making-an-invoice)). The merchant's app drops the used addresses and fills the lot again
when the merchant opens it.

Two calls of one assistant at the same time could take the same address from the same reads: an
implementation MUST take addresses one at a time for a key ([§17](#17-security)).

Vectors: `vectors/app/assistant.json`, `lot` and `used` (version 1), `lotV2` and `usedV2`
(version 2: 100 addresses, 21 used).

## 11. The payment link

The invoice's **sale**: from the CSPRNG,

- the **sale key**: 32 bytes;
- the **link secret**: 32 bytes, drawn again until they are a valid secp256k1 secret key. The link's
  **author** is its BIP-340 x-only public key.

| Name               | Derivation                                                            |
| ------------------ | --------------------------------------------------------------------- |
| sale secret        | HKDF(sale key, `sattle.me/sale`, `nostr-secret-key/v1`)               |
| sale author        | hex(BIP-340 x-only public key of the sale secret)                     |
| taker tag          | hex(first 16 bytes of HMAC(taker key, bytes of the sale author))      |
| link address (`d`) | hex(SHA-256(UTF-8 of `sattle.me/payment-link/address/v2` ‖ sale key)) |

The **link** is a sealed record of type `payment-link`, author the link's author, key the **sale
key** used as the NIP-44 conversation key as it is (no ECDH), address the link address, padded to a
multiple of 256 bytes, dated `startsAt` (when the link is made), with no other tag. Its value
(version 4), the members in this order:

- `version`: 4;
- `businessName`: the channel's `profile.businessName` (not blank, at most 200 code units);
- `lightningAddress`: the channel's `profile.lightningAddress`;
- `fiat`: `{"minor": <the invoice's totalMinor>, "digits": <its currency's digits>, "currency":
<its currency's code>}`, `minor` above 0;
- `note`: the word for invoice in the invoice's language, a space and its number (`Facture
2026-0042`), at most 200 code units: as the merchant's app writes it, `Facture` (French, the
  default), `Invoice` (English), `Rechnung` (German), `Fattura` (Italian), `Factura` (Spanish),
  `Fatura` (Portuguese), `Lasku` (Finnish); the payer's page shows it;
- `onchainAddress`: the deposit address taken ([§10](#10-on-chain-addresses)), or `null`;
- `startsAt`: now, when the link is made; `endsAt`: the invoice's `dueAt`; `startsAt` < `endsAt`
  and `endsAt − startsAt` ≤ 25 920 000 (300 days);
- `redirectUrl`: the invoice's, when it has one (absent otherwise), an `https` URL of at most 500
  code units ([spec/SPEC.md §15](spec/SPEC.md#15-http));
- `registryKey`, `registryReader`: the channel's; `owner`: the channel's `linkOwner`;
- `taker`: the taker tag;
- `bitcoinNode`: when the channel's `bitcoinNode` has `payers: true`, `{"url", "fallback"}` of it
  (absent otherwise), as a checkout link's record holds it
  ([spec/SPEC.md §30](spec/SPEC.md#the-record)).

The link is **published** to the merchant's relays, authenticating with the link secret: one relay
taking it is enough (the payer's page reads every relay of the URL), and the assistant MUST NOT
give the URL before one did.

**The URL**: `<linkOrigin>/pay#<author>.<sale key>.<relays>`: the channel's `linkOrigin`, the
author's 32 bytes and the sale key in base64url, and the relays as the key's third part is
([spec/SPEC.md §8](spec/SPEC.md#8-the-integration-key)). The relays are the merchant's. The
fragment never reaches the web app's host.

The payer's page reads the link, asks invoices of the merchant's Lightning address for the amount
due at each hour's point ([§9](#9-points-of-the-hour)) until `endsAt`, and declares each one in the
registry with the taker tag ([spec/SPEC.md §20](spec/SPEC.md#20-the-declaration)): « Par » names
the assistant. The link secret is kept only until the link's record is published
([§12](#12-the-links-record)), then forgotten: the merchant's app settles the link with its own key.

Vectors: `vectors/app/assistant.json`, `link` (with its `linkSecretKey`, given for checks only).

## 12. The link's record

So that the merchant's app finds and settles the link (its final version), the assistant
publishes the **link's record**: a sealed record of type `team-link`, author the links key, key the
records encryption key, address the link record address of the link's author, dated as the link.
Its value:

- `version`: 1;
- `link`: the link's author (hex32);
- `saleKey`: the sale key (hex32);
- `createdAt`: the link's `created_at`;
- `onchainTag`: the lot's tag of the link's deposit address ([§10](#10-on-chain-addresses)), `null`
  without one: the merchant's app counts an on-chain payment of the link only with it;
- `relays`: the link's relays;
- `sealedKey`: the link secret, as 64 lowercase hex characters, encrypted with NIP-44 v2 under the
  conversation key (ECDH) of the link secret and the channel's `linkKeyReader`: only the merchant
  opens it. A channel without `linkKeyReader` (an older merchant's app): under the
  channel's `registryReader` instead, whose secret an export grant gives ([§20](#20-exporting-the-transactions));
- `sealedFor`: `"link-key-reader"` when `sealedKey` is sealed for the `linkKeyReader`, absent when
  it is sealed for the `registryReader`. The record's `version` stays 1: the merchant's apps before
  it read the record, and ignore the member;
- `tolerance`: the channel's `onchainTolerance` when above 0, absent otherwise: the sale's
  tolerance of on-chain underpayments, for good ([§15](#15-following-a-payment)).

It is published on a **majority** of the merchant's relays, authenticating with the links secret,
before the invoice is: without it, the merchant's app does not settle the link.

Vectors: `vectors/app/assistant.json`, `linkRecord`.

## 13. Making an invoice

From what the assistant is asked (the recipient, the lines, the due date, the
conditions, the legal notice, a redirect URL), in this order:

1. Read the channel ([§5](#5-reading-the-channel)): removed, `revoked`; no `linkOrigin`,
   `no_web_app`.
2. Check the invoice as [§7](#7-the-invoice) and [§8](#8-amounts) say, in the channel's currency
   (not in [spec/currencies.json](spec/currencies.json): `unsupported_currency`); anything off is
   `invalid_invoice`, with what is off, before anything is taken.
3. Take a deposit address when the channel's `profile.onchain` is true
   ([§10](#10-on-chain-addresses)).
4. Without an address, the invoice is paid over Lightning only, at the point of each hour until its
   due date: read the Lightning address's pay request
   ([spec/SPEC.md §16](spec/SPEC.md#16-lightning-address)) and the point of the present hour
   (`pointHour(now)`, [§9](#9-points-of-the-hour)); the total's sats at that point MUST be at most
   80 % of the pay request's largest amount (its sendable maximum, rounded down to the sat, times
   80, divided by 100, rounded down). Above: `above_lightning`, with that largest number of sats.
   The pay request or the point not read (unknown included): `unverified`. No number is taken in
   either case.
5. Take a number ([§6](#6-numbers-of-invoices)).
6. Make the sale and the link ([§11](#11-the-payment-link)), publish the link.
7. Publish the link's record ([§12](#12-the-links-record)) on a majority.
8. Publish the invoice ([§7](#7-the-invoice)): `sent.at`, `createdAt` and `updatedAt` now (no
   earlier than the link's `created_at`, before `dueAt`), on the merchant's relays; one relay taking
   it is enough, all are tried.

A failure after step 5 leaves a gap in the series (step 5) or a link without an invoice (steps 6 and
7): the merchant's app settles such a link as any other, and lists no invoice for it. An
implementation MAY try steps 6 to 8 again with the same number while it holds it in memory, never
with another.

## 14. Reading the invoices

The assistant's invoices are its invoices author's records: query `{"kinds": [30078], "authors":
[<invoices author>]}` on the merchant's relays, paged ([spec/SPEC.md §13](spec/SPEC.md#13-relays)),
authenticating with the invoices secret. Open each event as a record of type `invoice` at the
invoice address of the `id` its value names (the event's `d` tag must be it), and keep each `id`'s
newest valid copy. A copy of a newer format newer than an `id`'s newest valid one hides it: the
assistant says that a newer app wrote it. The counter's copy (another type) is left aside. Fewer
than a majority answered: what was read may be incomplete, and the assistant says so: never « no
invoice ».

## 15. Following a payment

An invoice is **paid** by the rule the merchant's app settles a payment link with, which is the
integrations' own ([spec/SPEC.md §22](spec/SPEC.md#22-payment-check),
[§31](spec/SPEC.md#31-on-chain-payments)): a Lightning payment counts only with the preimage of its
payment hash, from the merchant's Lightning address's answer naming that very invoice, and only
when no other sale declared it; an on-chain payment counts once 3 blocks deep; the merchant's
tolerance and acceptance hold. The assistant tells it **as soon as the payments prove it**, without
waiting for the merchant's app. It states only what is proven
([spec/SPEC.md §27](spec/SPEC.md#27-security)): « not read » is never « unpaid », « expired » nor
« partially paid ».

The assistant follows an invoice from its `sent.link` (the link's author, the sale key, the relays):
it reads the link back (its published payload, as the payer's page does: the first valid copy of
the link's author), the link's record ([§12](#12-the-links-record): its `tolerance`, absent: 0)
and the channel (its `bitcoinNode`). Without the link or the record (fewer than a majority, or not
found), the status is `checking`.

### The final version

Read the link's copies, `{"kinds": [30078], "authors": [<the link's author>], "#d": [<link
address>]}`, and the merchant's, `{"kinds": [30078], "authors": [<the sale's owner key>], "#d":
[<owner final address>]}`, on the link's relays, authenticating with a key of that read alone. The
**sale's owner key** is `Q = P + t·G`, `P` the link's `owner` lifted with an even y (BIP-340), `t` =
SHA-256(UTF-8 of `sattle.me/payment-link/owner/v1` ‖ the 32 bytes of `owner` ‖ the sale key) as an
integer modulo the curve's order (0: unusable); its x coordinate, hex. The **owner final address**
is hex(SHA-256(UTF-8 of `sattle.me/payment-link/owner-final/v1` ‖ the 32 bytes of the link's
author)). Each copy opens as a `payment-link` record with the sale key; a copy with a member
`final` is a final version, whose `final.link` MUST be the link's author, and whose `owner`, for
the merchant's, the link's `owner`. Of several valid final versions, the merchant's with
`received` above 0 (paid or underpaid) before any other, then the earliest (lowest `created_at`,
then lowest `id`). A cancellation is not final for the merchant's app until the sale's end and 3
hours: a Lightning invoice kept in a payer's wallet, or the link's address, can still be paid, and
the merchant's app then settles the sale over the cancellation. The merchant's only: the link's
own final version never replaces one.

A **valid final version** is the link's payload (version 4 as published) and `final`:

- `status`: `"paid"`, `"underpaid"`, `"expired"` or `"canceled"`;
- `received`: sats, a decimal string (`0` or `[1-9][0-9]{0,15}`), the sum of the payments below;
- `lightning`: at most 50 `{"invoice", "preimage"}`: a BOLT11 invoice of the main network
  ([spec/SPEC.md §19](spec/SPEC.md#19-bolt11)) with an amount of whole sats above 0, none twice,
  and `preimage` hex32 whose SHA-256 is its payment hash;
- `onchain`: `null` when nothing paid the link's address (the payload's `onchainAddress` is then
  `null`), else `{"address": <it>, "transactions": [1 to 50 {"txid": hex32, "receivedAt": <Unix ms
above 0>, "sats": <decimal string above 0>}, none twice], "sats": <their sum>}`;
- `link`: the link's author;
- expired or canceled: `due` and `point` `null` and `received` `0`;
- paid or underpaid: `due` the sats of the payload's `fiat` at `point.rate`
  ([§9](#9-points-of-the-hour)), above 0, `point.hour` an hour above 0; underpaid:
  `0 < received < due`; paid: `received ≥ due`, or `accepted: true` with something paid on-chain
  and `received` from `due − ⌊due × 1000 / 10 000⌋` to `due − 1` (`accepted` only so, and only in a
  paid one).

A final version that is not so is ignored. A valid one **prevails**: the invoice's status is its
status (`paid`, `underpaid` ended, `expired`, `canceled`), whatever the assistant would judge.

### The sale's payments

Without a final version, the assistant judges the sale itself, at `now`, from these reads. Any read
that fails or answers fewer than a majority where one is asked makes the status `checking`, with
what was not read: never a guess.

1. **Lightning.** The sale's declarations: `{"kinds": [30078], "authors": [<sale author>]}` on the
   link's relays, paged, authenticating with the sale secret, on a majority. Each is opened as
   [spec/SPEC.md §20](spec/SPEC.md#20-the-declaration) says, the sale being the link's (its sale key,
   sale secret and author; the registry of the payload's `registryKey` and `registryReader`); one
   per payment hash. The Lightning address's pay request is read now
   ([spec/SPEC.md §16](spec/SPEC.md#16-lightning-address)). A declared invoice **may pay the sale**
   when:
   - its verify URL's host is the host of the pay request's callback;
   - it ends within the period of its own hour: `timestamp + expiry ≤ pointEnd(pointHour(timestamp))`;
   - it lies within the sale: `timestamp ≥ startsAt − 60` and `timestamp + expiry ≤ endsAt + 60`;
   - its description hash is the SHA-256 of the pay request's `metadata`. Another hash, the rest
     being so: the invoice may have been made under a former name of the business, which the
     merchant's app accepts and the assistant cannot tell: the status is `checking` (`former_name`)
     until the final version.

   Each one that may pay the sale is checked as
   [spec/SPEC.md §22](spec/SPEC.md#22-payment-check) says (its expiry the BOLT11's `timestamp +
expiry`): `paid`, with its preimage; `open` (not final yet: `checking` once the sale ended);
   `expired`; any error, `checking`. A paid one counts only when it is **unique**: query
   `{"kinds": [30078], "#d": [d(H)], "limit": 20}` on the link's relays, `d(H)` its registry
   address ([spec/SPEC.md §10](spec/SPEC.md#10-key-derivations)), authenticating with the sale
   secret. An event of another author whose content opens as a declaration's outside with that
   author's outer key ([spec/SPEC.md §20](spec/SPEC.md#20-the-declaration)) is a **conflict**: the
   payment counts for no sale (the merchant settles it). Else it is unique only when a majority of
   the relays answered with fewer than 20 events; otherwise `checking`. Each payment counted has its
   **hour**, `pointHour(timestamp)`, and its sats, its amount.

2. **On-chain**, when the payload's `onchainAddress` is not `null`. The transactions paying the
   address and their confirmations, from the explorer of the merchant's devices: the channel's
   `bitcoinNode` with its `fallback`, else mempool.space
   ([spec/SPEC.md §31](spec/SPEC.md#explorers),
   [the merchant's Bitcoin node](spec/SPEC.md#the-merchants-bitcoin-node)). A transaction pays what
   its outputs pay the address; one paying 0 is left out. Each transaction's **time** (Unix ms),
   as the merchant's app and the payer's page tell it, with mempool.space and BlockCypher whatever
   the node:
   - in the mempool, mempool.space's first sight
     (`GET https://mempool.space/api/v1/transaction-times?txId[]=<txid>`), unless it lies from
     HH:00:00 to HH:09:59 (within 300 s of a change of point: two servers of mempool.space could
     tell two hours apart);
   - otherwise BlockCypher's time ([spec/SPEC.md §31](spec/SPEC.md#explorers): `received`).
   - **Replacements**: mempool.space's history of the replacements of each transaction listed
     (`GET https://mempool.space/api/v1/tx/<txid>/rbf`) names the transactions it replaced; each
     named that BlockCypher knows gives what it paid the address, its coins and its time. The parts
     of the transactions ([spec/SPEC.md §31](spec/SPEC.md#replacements), each ordered by its time)
     give each listed transaction its sources: its time is the latest of its sources' times. A
     history or a time not told yet: `checking`.

   The sale's on-chain **sats** are the sum of what the listed transactions pay; their **hour** is
   `pointHour` of the latest time of a listed transaction (in seconds). A listed transaction whose
   time is after `endsAt`: the merchant's app may count it at an hour that the assistant cannot
   bound, and the status is `checking` (`late_payment`) until the final version.

3. **The merchant's acceptance** of the sale, when what was received is short: a sealed record of
   type `sale-accepted`, author the sale's owner key, address hex(HKDF(sale key,
   `sattle.me/sale-acceptance`, `address/v1`)), key HKDF(sale key, `sattle.me/sale-acceptance`,
   `encryption-key/v1`), read on the link's relays (the newest valid copy); value `{"version": 1,
"received": <sats>, "due": <sats>}`, both decimal strings `[1-9][0-9]{0,15}`, `received < due ≤
2 100 000 000 000 000`, other members ignored, a version above 1 a newer format (not counted).

### The status

`received` = the Lightning payments' sats + the on-chain sats. The **span**: from the latest hour
of a payment (Lightning or on-chain) to the latest of that and `min(pointHour(now),
pointHour(endsAt − 1))`. The **amount due** is the lowest amount due at the points of the span's
hours ([§9](#9-points-of-the-hour)), `bestDue`, at the earliest hour that gives it. A span hour whose
point is unknown is left out when it is the present hour and no payment's; any other unknown makes
the amount due unknown, unless `received` already pays the lowest amount of the hours known. The
on-chain part's target is `dueOnchain(bestDue, tolerance, lightning sats)`
([spec/SPEC.md §31](spec/SPEC.md#the-merchants-tolerance): nothing when Lightning paid `bestDue`,
else its least accepted less what Lightning paid, a sat at least).

In this order:

1. Lightning pays `bestDue`: **`paid`** (`lightning`, or `mixed` with on-chain sats).
2. On-chain sats above 0: the amount due unknown, `checking`; on-chain sats at least the target:
   **`paid`** (`onchain` or `mixed`) when every listed transaction is 3 blocks deep on the explorer
   read, else **`confirming`** (paid, the network confirms it: not final, a replacement may still
   change it), with the shallowest confirmations; below the target: as 4.
3. Nothing received: before `endsAt`, **`open`**; after, `checking` while a declared invoice of the
   sale is not final yet (its end + 120 s), else **`expired`**.
4. Less than due received: before `endsAt`, **`underpaid`** with `received` and the rest at the
   present hour's point (unknown while it is not published); after `endsAt`, `checking` while a
   declared invoice is not final, else **`underpaid`** ended, with `received` and `bestDue`. Either
   way, with the merchant's acceptance and `received` at least its `received`: **`paid`**
   (accepted, at what was received).

`paid` is final: what proves it (preimages, transactions 3 blocks deep, the merchant's acceptance)
proves it to the merchant's app too, whose devices may only know more payments or earlier times
(a transaction they saw before it was replaced, invoices made under a former name of the business),
which lower the amount due and never undo a payment. Every other status may change with a later
read, `expired` and an ended `underpaid` included: a transaction paying the address later still
counts for the merchant's app, at its own hour. A valid final version, once there, prevails.

## 16. Two ways to run it

The same code runs in two ways; the protocol above is the same.

- **Local** (Claude Desktop, or any MCP client over stdio): the server runs on the merchant's own
  computer, one process for one key, which the merchant gives it in its client's configuration (a
  secret field: the operating system's secret store where the client has one). Its requests go
  from that computer.
- **What a client is given**: only the tools of what the merchant allows this assistant now. Before
  it answers a `tools/list` request, a server reads the channel ([§5](#5-reading-the-channel)) and
  the export's decision ([§20](#20-exporting-the-transactions), the decision alone) on the
  merchant's relays: the invoices' tools (`business_profile`, `preview_invoice`, `create_invoice`,
  `list_invoices`, `invoice_status`, `invoice_pdf`, `invoice_card_pdf`) with a channel of version 1, and
  `export_transactions` with a decision that allows it. When either cannot be read (`network`,
  `revoked`, `not_found`, `newer`), the request gets a JSON-RPC error that says which, never a list
  on a guess. Each tool still checks what it does when called: a client that kept an older list is
  refused what the merchant no longer allows. A client keeps the list it was given until it asks
  again: a change in the app shows in the AI app once it asks again (its connector's tools list
  refreshed, or reconnected).
- **Hosted** (`https://mcp.sattle.me`, an MCP server over Streamable HTTP, for any MCP client that
  speaks OAuth 2.1: Claude, ChatGPT, an IDE…): the merchant connects its MCP client to it and gives the key once, on the server's own consent page, never to the
  model. The server keeps no key nor invoice: the key travels, sealed with a key of the server's,
  inside the access and refresh tokens it gives the client (OAuth 2.1, PKCE), and lives in memory
  for one request only. With it, the tokens seal the languages the merchant's browser prefers when
  it gives the key (its `Accept-Language` on the consent page, at most 8 tags): the region of its
  invoices' PDFs, below. Revoking the assistant in the app stops it at the next request; deleting the
  connector forgets the tokens. The requests to the relays, the Lightning address, CoinGecko and the
  explorers go from the hosted server: they see its IP address, not the merchant's. What the
  hosted server sees (each request's clients' names and amounts, in memory only) is that of a
  service sattle.me runs, under its privacy policy. Anyone may run the same hosted server for
  themselves (self-hosted, docs/SELF-HOSTING.md): it then sees the same, and holds its own
  sealing secret.
- **Files, hosted**: an invoice's PDF and an export are given as a download link of 15 minutes,
  never in the tool's answer (Claude rejects a binary resource there). The answer tells the model
  to download the file itself when it works with it (to attach, store, print or convert it), the
  bytes the merchant's app would write, and else to give the user the link. An AI app's code
  sandbox reaches only the hosts its user allowed: the server's host must be allowed there once, by
  the user (in Claude, Settings › Capabilities; an organization's owner), which no server can do;
  refused, the model says so. The downloads are limited per key: an AI app's sandboxes may share
  their addresses.
- **The invoice card** (MCP Apps: the extension `io.modelcontextprotocol/ui`, version 2026-01-26):
  `preview_invoice` and `create_invoice` name a page, `ui://sattleme/invoice-card.html`
  (`text/html;profile=mcp-app`), which an AI app that can shows in the conversation; the others
  ignore it, and the tools answer the same text either way. The page declares no domain (the AI
  app gives it the extension's strictest content security policy: it reaches no network) and calls
  only this server's tools, through the AI app: `preview_invoice` while the user completes what is
  missing (the client's address…), `create_invoice` once the user clicked its button on what it shows, and
  `invoice_card_pdf`, its own tool (visibility `app`: the AI app does not list it to the model),
  which gives an invoice's PDF in its answer, base64 in a text, for the AI app to save on the user's
  device. It tells the model what it made where the AI app takes it (`ui/update-model-context`).
  The server's instructions and these two tools' descriptions ask the model not to show again,
  in a table, a card or a list of its own, the invoice a card shows, but to say what remains to
  do (ChatGPT may otherwise draw its own card of it beside this one, with a « Langue » line when
  an invoice has no language: `language` names only its link's note and the PDF the card offers
  first). Without a card, the model shows the recipient, every line and the total before the user
  confirms ([§17](#17-security)).
- **Made at once**: when the user's own message asks for an invoice and gives the recipient's name
  and full address and every line, the model makes it without a preview nor a question:
  `business_profile`, then `create_invoice` with the total it computes (`expectedTotal`), without `previewedAt` (its window is then the last 24 hours), the due
  date left out when the user named none (`defaultDueDate`). Only `create_invoice`'s card is shown:
  the invoice made, its PDF. A detail missing, or the user asking to see it first, goes by
  `preview_invoice` and its card, made with one click; a total refused (`invalid_invoice`, nothing
  made) too, for the user to confirm it.
- **Made once**: an AI app shows a card again when the conversation is opened again, its button
  with it; the model may be asked « make it » once the card made it, and preview it anew first; a
  host may give up on a call that made it. So an invoice is made only when no invoice of this
  assistant **like it** was made in its window, and that one is given back instead. Like it: the
  same recipient's name, the same lines in the same order, the same conditions, legal notice and
  redirect URL (the texts as given, trimmed); not the address, the reference, the due date, the
  language nor the time zone, which the user completes or corrects within one preview, in the card
  or in the conversation. Its window: from its preview's second, `previewedAt` (ISO 8601 in UTC),
  and the last 24 hours at least. `preview_invoice` gives `previewedAt` (given an earlier
  preview's, that one), also with the error of an invoice that is not valid, which the card
  completes; and `alreadyMade`, the newest invoice like it made in its window, or null, told before
  what is off when it could be one made (a name, and only its address or due date off): a card shown
  again weeks later is that invoice. `create_invoice` takes `previewedAt` and makes the invoice
  ([§13](#13-making-an-invoice)) only when none like it was made in its window, else gives that
  one back (`alreadyMade: true`), nothing taken; the read and the making wait for the key's other
  invoices, as making does. Another invoice like one made is made only with `repeat: true`, which
  the model passes once the user, told of the first, asked for another. Only a read that proves it
  says « none »: fewer than a majority of the relays answered (`network`), or a newer app's copy
  written in the window hid an invoice (`newer`), and nothing is made. A `previewedAt` that is not
  a time this server gives (ISO 8601 in UTC, a time that exists, from 2000 to five minutes ahead) is
  `invalid_invoice`. An invoice whose publication reached fewer than a majority of the relays
  ([§13](#13-making-an-invoice), step 8) may not be read for a while: then it may be made twice.
- **The card's PDF**: `invoice_card_pdf` gives the file in its answer, as the local server's
  `invoice_pdf` does, hosted too: the card saves it through the AI app, which fetches no link for
  it. An AI app that lists it to its model anyway (one that ignores the visibility) may have it
  read there; it is limited as every call of a key (60 a minute).

An invoice's PDF writes its numbers and dates (its locale, such as `de-CH`) and German's variant
(Swiss German in Switzerland and Liechtenstein, as the merchant's app writes it) as the merchant's
region does, never its recipient's. That region is, in this order: the region of the merchant's
first preferred language in the invoice's language (the locale the invoice card sends: the language
picked at the end of its PDF button, in the AI app's region; then the computer's languages locally,
the browser's it connected with hosted); the channel's `detectedCountry`; the region of its other
preferred languages; its business's country; else none (the language alone). No other service is
asked. At the end of the card's PDF button (one button split by a thin line), the user picks the
PDF's language among the app's (German in its two variants), the card's own first: `invoice_card_pdf` gets its `language` and that `locale` (« en-CH », « de-CH », « de-DE »).

## 17. Security

[spec/SPEC.md §27](spec/SPEC.md#27-security) holds. Besides:

- The key is a secret: never in a log, a page, a repository, an error or a message to the model.
  Whoever holds it can do what [§3](#3-the-assistant-key) says, never spend. The merchant removes
  the assistant in the app when it leaks, and creates another: no rotation.
- A removed assistant's copy of the counter still counts for a year: a holder of its key can make
  numbers jump meanwhile, never give one twice.
- An assistant driven by a language model MUST make an invoice only on its user's own request in
  the conversation, never on a text the model reads (a mail, a web page, a tool's answer), which
  may ask it to make one. The user's message that asks for an invoice and gives all it takes is
  that request: the invoice is made at once, without a second confirmation
  ([§16](#16-two-ways-to-run-it), « Made at once »); otherwise the user confirms the
  preview. This server's `create_invoice` is its one tool that is not read-only, and makes an
  invoice only with the total expected (`expectedTotal`: the one the user confirmed, or the one the
  model computed from the user's lines), to the last cent: a total off makes nothing, and the model
  then has the user confirm it. The AI app may still ask the user before calling it
  (`destructiveHint: true`: ChatGPT asks for a write by default). The worst case is an invoice that
  pays the merchant and a number used.
- What an assistant reads (its invoices: its clients' names and addresses) goes to whatever runs it,
  a model's provider included: the merchant chooses it.
- Invoices are made one at a time for a key, and so are addresses taken
  ([§10](#10-on-chain-addresses)): within a process by a lock, and, hosted, by sending every
  request of one key to the same process.
- Hosted: the key never reaches the model nor the client but sealed (AES-256-GCM with a key of the
  server's, bound to the token's purpose and expiry); the consent page is the server's own, served
  with a strict content security policy; only the client that asked a code redeems it (PKCE S256,
  its redirect URI registered); each key and each address is rate-limited.
- Hosted: any client may connect, with redirect URIs as OAuth allows them: https, http on a
  loopback address (RFC 8252, any port), or an app's own scheme; never a scheme a browser runs or
  that opens something else (spec/SPEC.md §30, Redirect URLs). A client whose client_id is its
  metadata document's https URL (CIMD) is named on the consent page by that URL's host, which it
  proves by serving the document; the server reads such a document from public addresses only,
  follows no redirect, and reads 5 kB at most. Any other client registers (RFC 7591), and its name
  proves nothing. Either way, the consent page shows where the code goes back, which the merchant
  checks before giving the key; a page that sent the merchant there with a redirect of its own
  would get a token holding the key. The server may be limited to listed redirect URIs
  (`MCP_ALLOWED_REDIRECTS`).
- Hosted: what the server reaches for a key (its relays, the Lightning address and the URLs it
  answers, the price and explorer services, the merchant's Bitcoin node) is reached as a client's
  metadata document is: public addresses only, checked on every address a name resolves to and on
  a literal address; https and wss only; a relay on port 443 only. A Bitcoin node that is not of the
  Internet is on the merchant's network: set aside when its fallback is `mempool`; with `none`, its
  reads fail, and mempool.space is not read. A key's holder cannot make the server reach its own
  network.
- The invoice card ([§16](#16-two-ways-to-run-it)): an AI app asks the user no approval for the
  calls a page makes (Claude's documentation, 11.11.2026), so the card's button is the user's
  confirmation, one click (no second one), of what it shows, which
  `create_invoice` checks as for the model (`expectedTotal`); the button makes only the preview it
  shows. It shows every text as text, never as HTML: the tools' answers hold what the model wrote.
  Beside its button, it shows every line, the conditions, the legal notice, the due date and where
  the payer goes once paid (the redirect's host). It reaches no network, keeps nothing in the browser, and makes no invoice like
  one made in its window (« Made once », with its one exception).
- An assistant created without invoices ([§5](#5-reading-the-channel)) never had the counter key
  nor the web app of the links: a holder of its key cannot take a number of the merchant's series,
  and the merchant's app lists none of its invoices.
- The export ([§20](#20-exporting-the-transactions)) reads what the merchant's grant opens, every
  sale of the business with its amount, its note and who took it: whatever runs the assistant, and
  the model's provider, receive them. The merchant allows it for each assistant apart, off by
  default, and withdraws it at once in the app.

## 18. Constants

| Constant                     | Value                                                   |
| ---------------------------- | ------------------------------------------------------- |
| Key prefix                   | `sattleme_ak_`                                          |
| Assistant salt               | `sattle.me/assistant`                                   |
| Member salt / taker salt     | `sattle.me/team-member` / `sattle.me/declaration-taker` |
| Counter salt                 | `sattle.me/invoice-counter`                             |
| Counter type / version       | `invoice-counter-shared` / 1                            |
| Channel type / versions      | `team-channel` / 1, 2 (without invoices)                |
| Counter writers in a channel | 64 at most                                              |
| Invoice type / version       | `invoice` / 1                                           |
| Invoice padding              | 1024 bytes                                              |
| Lines                        | 1 to 50                                                 |
| Line name, recipient fields  | 120 code units                                          |
| Terms, legal notice          | 1000 code units                                         |
| Redirect URL                 | 500 code units, `https`                                 |
| Quantity                     | 1 to 9 999 999 hundredths                               |
| VAT rate                     | 0 to 10 000 basis points                                |
| Largest amount               | 99 999 major units and their decimals                   |
| Due date                     | the day after today to 9 months later                   |
| Default due date             | 30 days after today                                     |
| Point delay / period         | 300 s / 3600 s                                          |
| Lot type / used type         | `team-onchain-lot` / `team-onchain-used`                |
| Lot size                     | 20 addresses (version 1), 100 (version 2)               |
| Link type / version          | `payment-link` / 4                                      |
| Link address prefix          | `sattle.me/payment-link/address/v2`                     |
| Owner final prefix / tweak   | `sattle.me/payment-link/owner-final/v1` / `…/owner/v1`  |
| Longest sale                 | 25 920 000 s (300 days)                                 |
| Link record type / version   | `team-link` / 1                                         |
| Acceptance type / salt       | `sale-accepted` / `sattle.me/sale-acceptance`           |
| Lightning margin             | 20 % of the largest amount of the pay request           |
| Sale start tolerance         | 60 s                                                    |
| Uniqueness read              | 20 events per relay                                     |
| Confirmations                | 3                                                       |
| Payments in a final version  | 50 of each kind at most                                 |
| Highest tolerance            | 1000 basis points                                       |

## 19. Conformance vectors

[`vectors/app/assistant.json`](vectors/app/assistant.json), made by the merchant's app from the
BIP-39 test mnemonic (all-zero entropy), never a real wallet: the key and every derivation, the
channel and the lots the merchant wrote (versions 1 and 2), a used record of each, the merchant's
copy of the counter (the
assistant's next number: `next`), an invoice of the assistant with its totals, its payment link
(with the link's secret, for checks only) and the link's record. An implementation derives every
value, opens every record with the vector's keys, takes the next number from the counter, computes
the totals, and makes a link, a link's record, an invoice and a copy of the counter that open with
the vector's keys to the same values (its own random bytes give their keys, events and URL). The
app's test suite (`src/__tests__/assistant-vectors.test.ts` of the app) reads the same file, whose
SHA-256 it pins: a change on either side breaks one of them.

[`vectors/app/assistant-no-invoicing.json`](vectors/app/assistant-no-invoicing.json), made by the
merchant's app for the same assistant: the channel of version 2 the merchant writes for an
assistant created without invoices ([§5](#5-reading-the-channel)). An implementation opens it with
the vector's keys to the same values, with no invoicing. Both test suites pin its SHA-256.

## 20. Exporting the transactions

An assistant the merchant allows exports the merchant's transactions of a period for the
accountant: the CSV and the PDF report of the merchant's app's « Portefeuille › Exporter », the same
columns, texts and amounts, written as the merchant's phone writes them. It reads the merchant's
relays itself, without the merchant's wallet, and checks every payment before it counts: what it
cannot prove is told, never counted, never left out unsaid ([spec/SPEC.md §27](spec/SPEC.md#27-security)).

### The grant

The merchant allows each assistant apart, in the app (« Intégrations », the assistant's line), off by
default. Two sealed records, author the team key (the key's `team`), key the **export encryption
key**, HKDF(`K`, `sattle.me/assistant`, `export/encryption-key/v1`), at addresses of the **export
address key**, HKDF(`K`, `sattle.me/assistant`, `export/address-key/v1`):

- **the decision**, type `assistant-export`, `d` = hex(HMAC(export address key, UTF-8 of
  `decision`)): `{"version": 1, "allowed": <boolean>, "updatedAt": <its created_at>}`;
- **the keys**, type `assistant-export-keys`, in 1 to 16 parts, `d` of part `n` = hex(HMAC(export
  address key, UTF-8 of `keys/<n>`)): `{"version": 1, "grantedAt": <the decision's updatedAt>,
"part": n, "parts", "seats": [...]}`, part 0 also `"account"`, `"format"` and `"omitted"`; a part
  withdrawn is `{"version": 1, "grantedAt": null, "part": n}`.

Read `{"kinds": [30078], "authors": [<team>], "#d": [<the decision's>, <the 16 parts'>]}` on the
channel's relays, not paged, authenticating with the member secret; fewer than a majority answered:
`network`. The newest decision must allow it (else `export_not_allowed`); every part from 0 to
`parts − 1`, the newest at its address, must name that decision's `grantedAt` and the same `parts`
(else `export_unread`: written after the decision, try again); a record of a newer format among
them: `newer`. The grant gives reading keys only, never a key that signs, spends or reads the
wallet:

- `account`: `registryReader` (the secret half of the registry's reading key: it opens the inside of
  declarations), and `{author, encryptionKey, addressKey}` of the merchant's `invoices`, the
  `paymentRates` and `walletSends` (the app's records of its sendings), the `archive` and the
  `legacyHistory` (the history copied from the merchant's former payment service);
- `format`: the `language` (two letters: `de` for both German variants, which the `locale` tells),
  `locale` and `timeZone` (or `null`) of the device that allowed it;
- `seats`: each owner's device (`owner`), employee, assistant and integration of the team, removed
  ones too (`removedAt`), with the authors and keys of their records (`records`: `sales`, `links`,
  `encryptionKey`, `addressKey`), an assistant's `invoices`, an integration's `channelKey` and the
  authors and address keys of its witnesses (`seen`, `paid`); `omitted`: removed seats left out.

The merchant withdraws the grant in the app, which writes the decision `allowed: false` first:
every later export, and every download of an earlier one, stops. A copy of the keys taken while it
was allowed still reads: nothing in a protocol of relays can take it back.

### The period

Whole days, `first` to `last` (YYYY-MM-DD), in the time zone of the export (the call's, else the
grant's `format`, else UTC); `last` not after today there, `first` within the last 365 days
(the points of CoinGecko the app reads): `invalid_export` otherwise. Its range: from the first
second of `first` to the last of `last`, and never past now. Language, locale and time zone: the
call's, else the grant's, else `fr`. German is written in the variant of the locale's region, as the
merchant's app writes it (its `src/i18n/languages.ts`): Swiss German (the app's `de-CH`: ss, « »,
MWST) when the region is `CH` or `LI` (`de-CH`, `fr-CH`, `de-LI`…), German as Germany writes it
(`de`: ß, „ “, MwSt.) otherwise; the language a call or a grant names stays `de`.

### What it reads

Every read below is made on the channel's relays, paged ([spec/SPEC.md §13](spec/SPEC.md#13-relays)),
authenticating with the member secret; fewer than a majority answered: `network`, no export. A
record of a newer format that decides a line: `newer`. Each record is opened as the merchant's app
opens it (its type, its `d` tag against what it names, its author, its value), the newest copy of
each address kept.

1. **Sendings**: the records of `walletSends` (`wallet-send`) and their rates (`payment-rate`,
   whose `hour` is pointHour of their `at`) dated within the range: a line « Envoi » each, its
   amount, fees, reference and rate as recorded. A sending made outside the app has none.
2. **The v2 history** (`legacy-history-month`, `legacy-history-state`): the rows of each month (UTC)
   of the range copied whole (every part of one copy, the newest at its address, naming the same
   count and `set`, their rows each once and hashing to it), dated within the range. A month with
   parts but not whole, or a copy started and not finished: the export says the history is
   incomplete.
3. **The sales of the points of sale**: the records of each owner's device's and employee's `sales`
   (`team-sale`, `team-sale-onchain`, `team-sale-tx`) dated from 24 hours before the range to 24
   hours after it, grouped by sale (their `sale`). A sale whose records say it paid, or underpaid
   and accepted by the merchant (`sale-accepted`, [§15](#15-following-a-payment), by its `saleKey`),
   is a line once its payments are proven:
   - a Lightning invoice by the proof of its paid record (`lightning`: the invoice, of a payment hash
     of the sale's records, and its preimage), or, for a record of an earlier app without it, the
     Lightning address's answer at its `verifyUrl` (settled, its `pr` of that hash, the preimage);
     and only when its sale alone declared it in the registry
     ([spec/SPEC.md §20](spec/SPEC.md#20-the-declaration), at d(H), read whole on a majority);
   - a transaction its device saw paying the sale's address (`team-sale-tx`) or that its
     underpayment counted, paying the address 3 blocks deep on the merchant's explorer, at the time
     [§15](#15-following-a-payment) gives it.

   Dated by its latest payment (a Lightning payment at its record's `paidAt`). A device removed
   from the team vouches for what it saw before its removal only.

4. **The payment links and the invoices**: the records of each seat's `links` (`team-link`, made
   from 300 days and 24 hours before the range) and the invoices sent of the merchant's and each
   assistant's `invoices` (their number and recipient). Each link is read back
   ([§15](#15-following-a-payment); a link of a point of sale is of version 3: no start, no
   redirection, its sale 600 seconds until its end): its final version, when there is one, gives
   its payments (paid: a line; underpaid: a line once the merchant accepted it; expired or
   canceled: none); without one, its proven payments ([§15](#15-following-a-payment), The sale's
   payments, 1 and 2) are its line. A Lightning payment is dated by its invoice's timestamp. A sale
   of a point of sale shared as a link is the link's line only.
5. **The integrations' sales**: the Lightning witnesses of each integration
   ([spec/SPEC.md §32](spec/SPEC.md#32-lightning-witnesses), by its `paid` author, dated within the
   range): each invoice counted when one sale alone declared it (its declaration opened with the
   registry's reading key) and the merchant's Lightning address tells at its `verifyUrl` (of that
   address's host) that it was paid; dated by its witness. A sale in sats alone (currency `SAT`)
   has no amount of its own. An order paid on-chain (an on-chain witness of its sale, or the
   Lightning rest of one) is set aside: the merchant's app tells it.

Each sale's line carries the point of its payment's hour ([§9](#9-points-of-the-hour)) in the
merchant's currency, as the app records the rate of a payment; a point not published: none. An
amount converted is the app's (its rate on integers, rounded half up).

### Set aside, and what it does not hold

A sale recorded paid whose payment the assistant cannot prove (no proof and no answer of the
Lightning address, declared by no sale or by another, a transaction not 3 blocks deep yet, an
integration's order paid on-chain) is in no line: the export lists it apart, with when its device
saw it paid, its note, its amount and who took it. Neither the CSV nor the PDF holds what the
merchant's wallet received without a sale (its Lightning address paid without an invoice, a deposit
to an address of the wallet) nor what was sent outside the app: the PDF says so under the app's
note on the values, in the export's language, with the number of sales set aside; the tool's answer
says it all.

### The files

The lines within the range, the oldest first, written as the merchant's app writes them: the CSV
(its columns, the call's or the app's default ones) and the report, which this server draws as a
PDF with the app's measures. Vectors: `vectors/app/export.json`, made by the merchant's app: lines
and options with the CSV and the report's HTML it writes of them, a grant, and the records of each
source with the lines they make.

Hosted, the tool gives a link valid 15 minutes, which seals the key and the call's request; each
download reads and checks everything again, and nothing is kept.
