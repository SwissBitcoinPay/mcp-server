/**
 * The conformance vectors of the specification (spec/vectors/): what every implementation, in any
 * language, must give for each input. Every expected value here is written by hand from SPEC.md
 * (the conversions recomputed with exact fractions), never copied from this package's output:
 * test/conformance.test.ts checks the package against the files, and that the files are what this
 * module builds. Only generated: the texts of invoices and keys, so that a case says what it holds.
 * Written on purpose into a clone of checkout-spec:
 * UPDATE_VECTORS=1 VECTORS_OUT=<clone> npx vitest run test/conformance.test.ts.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import { currencyDigits } from "../../src/index.js";
import { bytesToBase64Url } from "../../src/encoding.js";
import { restKeys } from "../../src/derive.js";
import { INTEGRATION_KEY_PREFIX } from "../../src/protocol.js";

import { depositAddress } from "./chain.js";
import { makeInvoice, metadataHash, preimagePair } from "./lightning.js";
import { appVectors } from "./vectors.js";

const T = 1791378000;
const TEAM = appVectors.parsed.team;
const KEY = appVectors.parsed.integrationKey;
const TEAM_B64 = bytesToBase64Url(hexToBytes(TEAM));
const KEY_B64 = bytesToBase64Url(hexToBytes(KEY));
const hosts = (text: string) => bytesToBase64Url(utf8ToBytes(text));
const key = (...parts: string[]) => INTEGRATION_KEY_PREFIX + parts.join(".");

const invalidKey = (name: string, text: string) => ({
  name,
  key: text,
  expected: { error: "invalid_key" }
});

function integrationKeys() {
  return {
    description:
      "Integration keys (SPEC.md §8, The integration key): the parts of a valid key, or the error of an invalid one.",
    cases: [
      {
        name: "the app's vector",
        key: appVectors.secretKey,
        expected: { teamPublicKey: TEAM, integrationKey: KEY, relays: ["wss://relay.example"] }
      },
      {
        name: "several relays, a port and a path",
        key: key(TEAM_B64, KEY_B64, hosts("relay.example,nos.lol:4443,relay.example.ch/nostr")),
        expected: {
          teamPublicKey: TEAM,
          integrationKey: KEY,
          relays: ["wss://relay.example", "wss://nos.lol:4443", "wss://relay.example.ch/nostr"]
        }
      },
      invalidKey(
        "a later format's prefix",
        appVectors.secretKey.replace(INTEGRATION_KEY_PREFIX, "sattleme_ck2_")
      ),
      invalidKey(
        "the prefix sattleme_ without ck_",
        appVectors.secretKey.replace(INTEGRATION_KEY_PREFIX, "sattleme_")
      ),
      invalidKey("two parts", key(TEAM_B64, KEY_B64)),
      invalidKey("four parts", key(TEAM_B64, KEY_B64, hosts("relay.example"), "x")),
      invalidKey("base64 padding", key(TEAM_B64, `${KEY_B64}=`, hosts("relay.example"))),
      invalidKey(
        "standard base64 alphabet",
        key(`+${TEAM_B64.slice(1)}`, KEY_B64, hosts("relay.example"))
      ),
      invalidKey(
        "non-canonical base64url (padding bits set)",
        key(TEAM_B64, KEY_B64.slice(0, -1) + "h", hosts("relay.example"))
      ),
      invalidKey(
        "a 31-byte key",
        key(TEAM_B64, bytesToBase64Url(new Uint8Array(31).fill(7)), hosts("relay.example"))
      ),
      invalidKey(
        "a team key off the curve",
        key(bytesToBase64Url(new Uint8Array(32)), KEY_B64, hosts("relay.example"))
      ),
      invalidKey(
        "relays that are not UTF-8",
        key(TEAM_B64, KEY_B64, bytesToBase64Url(new Uint8Array([0xff, 0x61])))
      ),
      invalidKey(
        "relays after a byte order mark (kept: U+FEFF is no host)",
        key(TEAM_B64, KEY_B64, hosts("﻿relay.example"))
      ),
      invalidKey("no relay", key(TEAM_B64, KEY_B64, "")),
      invalidKey("a relay in upper case", key(TEAM_B64, KEY_B64, hosts("Relay.example"))),
      invalidKey("a relay twice", key(TEAM_B64, KEY_B64, hosts("relay.example,relay.example"))),
      invalidKey(
        "eleven relays",
        key(
          TEAM_B64,
          KEY_B64,
          hosts(Array.from({ length: 11 }, (_, i) => `r${i}.example`).join(","))
        )
      ),
      invalidKey("a space before the key", ` ${appVectors.secretKey}`)
    ]
  };
}

function relayUrls() {
  const ok = (url: string) => ({ url, valid: true });
  const no = (url: string) => ({ url, valid: false });
  return {
    description:
      "Relay addresses (SPEC.md §9, Relay lists): whether each is a relay address in its one spelling. Never repaired.",
    cases: [
      ok("wss://relay.example"),
      ok("wss://relay.example:443"),
      ok("wss://relay.example:1"),
      ok("wss://relay.example/nostr"),
      ok("wss://a-b.c.example/x/y~z"),
      ok("wss://xn--bcher-kva.example"),
      ok("wss://relay.example/bücher"),
      ok("wss://relay.example/\u{1f600}"),
      no("ws://relay.example"),
      no("WSS://relay.example"),
      no("wss://Relay.example"),
      no("wss://relay.example/"),
      no("wss://relay.example:0"),
      no("wss://relay.example:65536"),
      no("wss://relay.example?x=1"),
      no("wss://relay.example#x"),
      no("wss://relay.example/a,b"),
      no("wss://relay.example/a b"),
      no("wss://relay.example/a\u00a0b"),
      no("wss://relay.example/a\u3000b"),
      no("wss://localhost"),
      // RFC 6761: a name under `localhost` is the machine's own loopback; one holding it is not.
      no("wss://relay.localhost"),
      no("wss://a.relay.localhost:6379"),
      ok("wss://localhost.relay.example"),
      no("wss://127.0.0.1"),
      no("wss://relay.e"),
      // A name of one label: never a public host.
      no("wss://intranet"),
      no(" wss://relay.example"),
      no("wss://relay.example "),
      no(`wss://${"a".repeat(107)}.example`)
    ]
  };
}

const HASH = preimagePair(1).paymentHash;
const DESCRIPTION = metadataHash("[]");

function bolt11() {
  const real = appVectors.realInvoice;
  const decoded = (fields: {
    network?: string;
    amountMsat: string | null;
    timestamp?: number;
    expirySeconds?: number;
    paymentHash?: string;
    descriptionHash?: string | null;
  }) => ({
    network: fields.network ?? "bc",
    amountMsat: fields.amountMsat,
    timestamp: fields.timestamp ?? T,
    expirySeconds: fields.expirySeconds ?? 3600,
    paymentHash: fields.paymentHash ?? HASH,
    descriptionHash: fields.descriptionHash === undefined ? DESCRIPTION : fields.descriptionHash
  });
  const base = { paymentHash: HASH, descriptionHash: DESCRIPTION, timestamp: T };
  return {
    description:
      "BOLT11 invoices (SPEC.md §19, BOLT11): the fields of a valid invoice (amounts in millisatoshis, as strings), or null for an invalid one. The signature is not checked.",
    cases: [
      {
        name: "a real breez.tips invoice",
        invoice: real.invoice,
        expected: {
          network: "bc",
          amountMsat: real.amountMsat,
          timestamp: real.timestamp,
          expirySeconds: real.expirySeconds,
          paymentHash: real.paymentHash,
          descriptionHash: real.descriptionHash
        }
      },
      {
        name: "the same, in upper case",
        invoice: real.invoice.toUpperCase(),
        expected: {
          network: "bc",
          amountMsat: real.amountMsat,
          timestamp: real.timestamp,
          expirySeconds: real.expirySeconds,
          paymentHash: real.paymentHash,
          descriptionHash: real.descriptionHash
        }
      },
      {
        // Unicode's lowercase mapping reads U+212A as a k: bech32 is US-ASCII and its case alone.
        name: "the same in upper case, the Kelvin sign (U+212A) in place of a K",
        invoice: (() => {
          const upper = real.invoice.toUpperCase();
          const at = upper.indexOf("K", upper.lastIndexOf("1"));
          return `${upper.slice(0, at)}\u212a${upper.slice(at + 1)}`;
        })(),
        expected: null
      },
      {
        name: "no amount, no expiry field (3600 s)",
        invoice: makeInvoice(base),
        expected: decoded({ amountMsat: null })
      },
      {
        name: "an amount in pico-bitcoins",
        invoice: makeInvoice({ ...base, amountMsat: 1234n, expirySeconds: 600 }),
        expected: decoded({ amountMsat: "1234", expirySeconds: 600 })
      },
      {
        name: "testnet",
        invoice: makeInvoice({ ...base, network: "tb", amountMsat: 1_000_000n }),
        expected: decoded({ network: "tb", amountMsat: "1000000" })
      },
      {
        name: "two expiry fields: the last counts",
        invoice: withFields(base, [
          [6, integerWords(60)],
          [6, integerWords(900)]
        ]),
        expected: decoded({ amountMsat: null, expirySeconds: 900 })
      },
      {
        name: "an expiry field of 7 words",
        invoice: withFields(base, [[6, [0, 0, 0, 0, 0, 0, 1]]]),
        expected: decoded({ amountMsat: null, expirySeconds: 1 })
      },
      {
        name: "an expiry field of 8 words",
        invoice: withFields(base, [[6, [0, 0, 0, 0, 0, 0, 0, 1]]]),
        expected: null
      },
      {
        name: "an expiry field of 8 words after a valid one",
        invoice: withFields(base, [
          [6, integerWords(60)],
          [6, [0, 0, 0, 0, 0, 0, 0, 1]]
        ]),
        expected: null
      },
      {
        name: "a payment hash field of the wrong length is skipped",
        invoice: withFields({ ...base, paymentHash: undefined }, [
          [1, new Array<number>(51).fill(1)],
          [1, hashWords(HASH)]
        ]),
        expected: decoded({ amountMsat: null })
      },
      {
        name: "no payment hash",
        invoice: withFields({ ...base, paymentHash: undefined }, []),
        expected: null
      },
      {
        name: "21 million bitcoins",
        invoice: withHrp(base, "lnbc21000000"),
        expected: decoded({ amountMsat: "2100000000000000000" })
      },
      {
        name: "more than 21 million bitcoins",
        invoice: withHrp(base, "lnbc21000001"),
        expected: null
      },
      {
        name: "pico-bitcoins that are not whole millisatoshis",
        invoice: withHrp(base, "lnbc12345p"),
        expected: null
      },
      { name: "an amount with a leading zero", invoice: withHrp(base, "lnbc01u"), expected: null },
      {
        name: "mixed case",
        invoice: real.invoice.slice(0, 10).toUpperCase() + real.invoice.slice(10),
        expected: null
      },
      { name: "a space around it", invoice: ` ${real.invoice}`, expected: null },
      {
        name: "a wrong checksum",
        invoice: real.invoice.slice(0, -1) + (real.invoice.endsWith("q") ? "p" : "q"),
        expected: null
      },
      {
        name: "not lightning",
        invoice: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        expected: null
      }
    ]
  };
}

/* Invoices with chosen fields, for the cases makeInvoice cannot write. */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function integerWords(value: number, length = 0): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    out.unshift(rest % 32);
    rest = Math.floor(rest / 32);
  } while (rest > 0);
  while (out.length < length) out.unshift(0);
  return out;
}

function hashWords(hex: string): number[] {
  const out: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const byte of hexToBytes(hex)) {
    accumulator = ((accumulator << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((accumulator >> bits) & 31);
    }
  }
  if (bits > 0) out.push((accumulator << (5 - bits)) & 31);
  return out;
}

function polymod(values: number[]): number {
  const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= generator[i]!;
  }
  return chk >>> 0;
}

function encode(hrp: string, data: number[]): string {
  const codes = [...hrp].map((c) => c.charCodeAt(0));
  const expanded = [...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31)];
  const mod = polymod([...expanded, ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((w) => CHARSET[w]).join("")}`;
}

type Fields = { paymentHash?: string | undefined; descriptionHash: string; timestamp: number };

/** An invoice of `hrp` with the date, the payment hash (unless undefined), `extra` fields, the description hash. */
function invoiceWords(fields: Fields, extra: [number, number[]][]): number[] {
  const field = (tag: number, data: number[]) => [
    tag,
    Math.floor(data.length / 32),
    data.length % 32,
    ...data
  ];
  return [
    ...integerWords(fields.timestamp, 7),
    ...(fields.paymentHash ? field(1, hashWords(fields.paymentHash)) : []),
    ...extra.flatMap(([tag, data]) => field(tag, data)),
    ...field(23, hashWords(fields.descriptionHash)),
    ...new Array<number>(104).fill(0)
  ];
}

function withFields(fields: Fields, extra: [number, number[]][]): string {
  return encode("lnbc", invoiceWords(fields, extra));
}

function withHrp(fields: Fields, hrp: string): string {
  return encode(hrp, invoiceWords(fields, []));
}

/* Prices, currencies, conversions. */

function fiat() {
  const ok = (
    amount: string,
    currency: string,
    expected: { amount: string; minor: string; digits: number }
  ) => ({
    input: { amount, currency },
    expected: { ...expected, currency }
  });
  const bad = (amount: string, currency: string) => ({
    input: { amount, currency },
    expected: { error: "invalid_order", param: "fiat" }
  });
  return {
    description:
      "Prices in a currency (SPEC.md §25, Prices in a currency). `cases`: the price an order gives, read as minor units of its currency (currencies.json), or refused. `digits`: what currencyDigits gives for a text (SPEC.md §4, Functions): the decimals of the currency whose code it is exactly, or null for any other text (a code in lower case, around spaces, a fund, a metal, a test code, none at all, or a name an object holds in some languages).",
    cases: [
      ok("24.50", "CHF", { amount: "24.50", minor: "2450", digits: 2 }),
      ok("24.5", "CHF", { amount: "24.50", minor: "2450", digits: 2 }),
      ok("24.500", "CHF", { amount: "24.50", minor: "2450", digits: 2 }),
      ok("0024.50", "CHF", { amount: "24.50", minor: "2450", digits: 2 }),
      ok("1500", "JPY", { amount: "1500", minor: "1500", digits: 0 }),
      ok("1500.0", "JPY", { amount: "1500", minor: "1500", digits: 0 }),
      ok("1.234", "BHD", { amount: "1.234", minor: "1234", digits: 3 }),
      ok("10", "RSD", { amount: "10", minor: "10", digits: 0 }),
      bad("10.5", "RSD"),
      ok("0.01", "EUR", { amount: "0.01", minor: "1", digits: 2 }),
      ok("90071992547409.91", "CHF", {
        amount: "90071992547409.91",
        minor: "9007199254740991",
        digits: 2
      }),
      bad("90071992547409.92", "CHF"),
      bad("24.501", "CHF"),
      bad("1500.5", "JPY"),
      bad("0", "CHF"),
      bad("0.00", "CHF"),
      bad("-1", "CHF"),
      bad("+1", "CHF"),
      bad(" 1", "CHF"),
      bad("1 ", "CHF"),
      bad("1,50", "CHF"),
      bad("1e2", "CHF"),
      bad(".5", "CHF"),
      bad("5.", "CHF"),
      bad("1234567890123456", "CHF"),
      bad("1", "chf"),
      bad("1", "XAU"),
      bad("1", "CHE"),
      bad("1", "BTC"),
      bad("1", "SAT"),
      bad("1", "ABC")
    ],
    digits: [
      "CHF",
      "EUR",
      "JPY",
      "BHD",
      "KWD",
      "RSD",
      "IQD",
      "chf",
      " CHF",
      "CHF ",
      "CHE",
      "XAU",
      "XTS",
      "XXX",
      "BTC",
      "",
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty"
    ].map((code) => ({ code, expected: currencyDigits(code) }))
  };
}

function prices() {
  const text = (price: string, expected: string | null) => ({ price, expected });
  const number = (json: string, expected: string | null) => ({ json, expected });
  return {
    description:
      "Prices of one bitcoin (SPEC.md §25, Prices in a currency). `text`: a price a source wrote as a string, as its exact decimal (plain, shortest), or null when refused. `numbers`: a price a source wrote as a JSON number (the literal), read as an IEEE 754 double, then as the shortest decimal that reads back as that double.",
    text: [
      text("69012", "69012"),
      text("69012.50", "69012.5"),
      text("69025.1084416666694295", "69025.1084416666694295"),
      text("6.9012e4", "69012"),
      text("8e-8", "0.00000008"),
      text("1E+3", "1000"),
      text("00069012", "69012"),
      text("", null),
      text(" 69012", null),
      text("69012 ", null),
      text("-69012", null),
      text("+69012", null),
      text("0", null),
      text("0.000", null),
      text("1,5", null),
      text(".5", null),
      text("5.", null),
      text("0x10", null),
      text("Infinity", null),
      text("NaN", null),
      text("1e", null),
      text("1e64", "1" + "0".repeat(64)),
      text("1e65", null),
      text("1e-65", null),
      text("1".repeat(64), "1".repeat(64)),
      text("1".repeat(65), null)
    ],
    numbers: [
      number("69012", "69012"),
      number("69012.5", "69012.5"),
      number("69012.0", "69012"),
      number("0.30000000000000004", "0.30000000000000004"),
      number("1e-7", "0.0000001"),
      number("69025.1084416666694295", "69025.10844166667"),
      number("1.5e21", "1500000000000000000000"),
      // Two shortest decimals read back as this double, as near to it: the even one (SPEC.md §25).
      number("1660867710597813.25", "1660867710597813.2"),
      number("0", null),
      number("-5", null)
    ]
  };
}

function conversions() {
  const c = (amount: string, currency: string, price: string, sats: string) => ({
    fiat: { amount, currency },
    price,
    sats
  });
  return {
    description:
      "Sats for a price in a currency at the price of one bitcoin (SPEC.md §25, Prices in a currency): ⌈minor × 10^8 / (price × 10^digits)⌉, exact, rounded up to the next whole sat.",
    cases: [
      c("24.50", "CHF", "69012", "35502"),
      c("1.00", "CHF", "100000", "1000"),
      c("1500", "JPY", "15000000", "10000"),
      c("0.01", "CHF", "1000000", "1"),
      c("24.50", "CHF", "69025.1084416666694295", "35495"),
      c("0.001", "BHD", "250000", "1"),
      c("90071992547409.91", "CHF", "69012", "130516421125905510"),
      c("1.00", "CHF", "8e-8", "1250000000000000"),
      c("5", "JPY", "163.42", "3059602"),
      c("19.99", "EUR", "61234.5678", "32645")
    ]
  };
}

/* Notes, references, comments. */

function orderText() {
  const label = (note: string | null, expected: string) => ({
    ref: "ORD-1",
    note,
    expected: { label: expected }
  });
  const bad = (note: string) => ({
    ref: "ORD-1",
    note,
    expected: { error: "invalid_order", param: "note" }
  });
  return {
    description:
      "An order's reference and note (SPEC.md §17, Creating an invoice). `refs`: whether each reference is valid. `notes`: the label the declaration and the invoice's comment carry (null: no note given), or the error. `comments`: whether the label is sent as the LNURL comment, given the service's commentAllowed.",
    refs: [
      { ref: "ORD-1042", valid: true },
      { ref: "a.b_c:d-e", valid: true },
      { ref: "x".repeat(64), valid: true },
      { ref: "", valid: false },
      { ref: "x".repeat(65), valid: false },
      { ref: "ORD 1042", valid: false },
      { ref: "ORD/1042", valid: false },
      { ref: "ORD-1042€", valid: false }
    ],
    notes: [
      label(null, "ORD-1"),
      label("", "ORD-1"),
      label("   ", "ORD-1"),
      label("  Order 1042  ", "Order 1042"),
      label(" Order ", " Order "),
      label("é".repeat(100), "é".repeat(100)),
      label("😀".repeat(100), "😀".repeat(100)),
      bad("é".repeat(101)),
      bad("😀".repeat(101)),
      // A lone surrogate (SPEC.md §6), which a JSON escape makes; a pair is one code point.
      bad("Order \ud800"),
      label("😀 Order", "😀 Order"),
      bad("a\nb"),
      bad("\tOrder"),
      bad("Order\u007f")
    ],
    comments: [
      { label: "Order 1042", commentAllowed: 255, sent: true },
      { label: "Order 1042", commentAllowed: 10, sent: true },
      { label: "Order 1042", commentAllowed: 9, sent: false },
      { label: "éé", commentAllowed: 4, sent: true },
      { label: "éé", commentAllowed: 3, sent: false },
      { label: "ORD-1", commentAllowed: 0, sent: false }
    ]
  };
}

/* Invoice checks and payment checks. */

const METADATA = '[["text/identifier","shop@breez.tips"],["text/plain","Pay to Sunrise Bakery"]]';
const CALLBACK = "https://breez.tips/lnurlp/shop/invoice";

function invoiceChecks() {
  const paymentHash = preimagePair(2).paymentHash;
  const good = {
    amountMsat: 1_000_000n,
    paymentHash,
    descriptionHash: metadataHash(METADATA),
    timestamp: T,
    expirySeconds: 900
  };
  const verify = `https://breez.tips/lnurlp/verify/${paymentHash}`;
  const c = (
    name: string,
    pr: string,
    check: string | null,
    extra: { verify?: string; now?: number; durationSeconds?: number } = {}
  ) => ({
    name,
    answer: { pr, verify: extra.verify ?? verify },
    sats: "1000",
    durationSeconds: extra.durationSeconds ?? 900,
    now: extra.now ?? T,
    expected: check === null ? { valid: true } : { error: "invalid_invoice", check }
  });
  return {
    description:
      "The checks of an invoice the Lightning address answered (SPEC.md §18, Invoice checks), in their order: each case fails the check it names (`check`), or passes them all. The pay request: `payRequest`.",
    payRequest: { callback: CALLBACK, metadata: METADATA },
    cases: [
      c("valid", makeInvoice(good), null),
      c("valid, verify URL on the callback's host with another path", makeInvoice(good), null, {
        verify: "https://breez.tips/v/1"
      }),
      c("not BOLT11", "lnbc1notaninvoice", "bolt11"),
      c("testnet", makeInvoice({ ...good, network: "tb" }), "network"),
      c("another amount", makeInvoice({ ...good, amountMsat: 999_000n }), "amount"),
      c("no amount", makeInvoice({ ...good, amountMsat: undefined }), "amount"),
      c(
        "another merchant",
        makeInvoice({ ...good, descriptionHash: metadataHash("[]") }),
        "description_hash"
      ),
      c(
        "no description hash",
        makeInvoice({ ...good, descriptionHash: undefined }),
        "description_hash"
      ),
      c("verify URL in http", makeInvoice(good), "verify_url", {
        verify: verify.replace("https:", "http:")
      }),
      c("verify URL on another host", makeInvoice(good), "verify_url", {
        verify: "https://evil.example/verify"
      }),
      c("verify URL not a URL", makeInvoice(good), "verify_url", { verify: "verify" }),
      // An https URL (SPEC.md §15): its port is 443 when absent; nothing is repaired.
      c("verify URL with the port written (443): the callback's host", makeInvoice(good), null, {
        verify: verify.replace("breez.tips", "breez.tips:443")
      }),
      c("verify URL on another port", makeInvoice(good), "verify_url", {
        verify: verify.replace("breez.tips", "breez.tips:8443")
      }),
      c("verify URL with the host in upper case", makeInvoice(good), "verify_url", {
        verify: verify.replace("breez.tips", "Breez.tips")
      }),
      c("verify URL with a user name", makeInvoice(good), "verify_url", {
        verify: verify.replace("breez.tips", "user@breez.tips")
      }),
      c("verify URL with a backslash", makeInvoice(good), "verify_url", {
        verify: verify.replace("breez.tips", "breez.tips\\@evil.example")
      }),
      c("verify URL on an IP address", makeInvoice(good), "verify_url", {
        verify: verify.replace("breez.tips", "10.0.0.1")
      }),
      c("longer than asked", makeInvoice({ ...good, expirySeconds: 901 }), "duration"),
      c("no time at all", makeInvoice({ ...good, expirySeconds: 0 }), "expired"),
      c("dated 301 s ago", makeInvoice(good), "clock", { now: T + 301 }),
      c("dated 301 s ahead", makeInvoice(good), "clock", { now: T - 301 }),
      c("dated 300 s ago", makeInvoice(good), null, { now: T + 300 }),
      c(
        "dated 299 s ago, over after 60 s",
        makeInvoice({ ...good, expirySeconds: 60 }),
        "expired",
        {
          now: T + 299,
          durationSeconds: 60
        }
      )
    ]
  };
}

function payments() {
  const real = appVectors.realInvoice;
  const expiresAt = real.timestamp + real.expirySeconds;
  const before = expiresAt + 119;
  const after = expiresAt + 120;
  const ok = (body: Record<string, unknown>) => ({ status: 200, body: { status: "OK", ...body } });
  const error = (reason: string, status = 200) => ({ status, body: { status: "ERROR", reason } });
  const c = (
    name: string,
    now: number,
    http: { status: number; body?: unknown; bodyText?: string },
    expected: unknown
  ) => ({
    name,
    now,
    http,
    expected
  });
  const paid = { state: "paid", method: "lightning", preimage: real.preimage };
  const open = { state: "open", expiresAt, received: "0", rest: null };
  /** A body sent as `bodyText`: not a JSON value written as such. */
  const text = (bodyText: string) => ({ status: 200, bodyText });
  const settled = JSON.stringify({
    status: "OK",
    settled: true,
    preimage: real.preimage,
    pr: real.invoice
  });
  const expired = { state: "expired", received: "0" };
  return {
    description:
      'Payment checks (SPEC.md §22, Payment check): the status of `invoice`, which has no address (expiresAt = date + expiry; `received` is "0", `rest` null) from the LUD-21 answer to its verify URL, at `now`, or the error. The grace period ends at expiresAt + 120. `bodyText`: the body as sent, when it is not a JSON value written as such: one leading byte order mark is ignored (SPEC.md §15); JSON as SPEC.md §2 reads it (of two members with one name, the last counts; a number of any length is a double; a name may hold U+0000; no more than 64 arrays and objects nested; nothing else is JSON). `stored`: invoices as a shop stores them, checked before a payment check asks anything (SPEC.md §22): valid, or the error.',
    invoice: {
      bolt11: real.invoice,
      paymentHash: real.paymentHash,
      verifyUrl: `https://breez.tips/lnurlp/verify/${real.paymentHash}`,
      expiresAt
    },
    cases: [
      c("paid", before, ok({ settled: true, preimage: real.preimage, pr: real.invoice }), paid),
      c(
        "paid, the invoice in upper case",
        after,
        ok({ settled: true, preimage: real.preimage, pr: real.invoice.toUpperCase() }),
        paid
      ),
      c(
        "paid, the preimage in upper case",
        before,
        ok({ settled: true, preimage: real.preimage.toUpperCase(), pr: real.invoice }),
        paid
      ),
      c(
        "paid without status OK",
        before,
        { status: 200, body: { settled: true, preimage: real.preimage, pr: real.invoice } },
        paid
      ),
      c(
        "paid, the body after a byte order mark (one, ignored)",
        before,
        text(`\ufeff${settled}`),
        paid
      ),
      c("two byte order marks: not JSON", before, text(`\ufeff\ufeff${settled}`), {
        error: "network"
      }),
      c(
        "a name twice: the last counts",
        before,
        text(
          `{"status":"OK","settled":false,"preimage":null,"settled":true,"preimage":"${real.preimage}","pr":"${real.invoice}"}`
        ),
        paid
      ),
      c(
        "a name twice, the last not settled: not paid",
        before,
        text(`${settled.slice(0, -1)},"settled":false}`),
        open
      ),
      c(
        "a name in another case is another name: Settled is not settled",
        before,
        text(
          JSON.stringify({ status: "OK", Settled: true, preimage: real.preimage, pr: real.invoice })
        ),
        open
      ),
      c(
        "a member of 5000 digits: a number, still JSON",
        before,
        text(`${settled.slice(0, -1)},"extra":${"9".repeat(5000)}}`),
        paid
      ),
      c(
        "a member 1e400: a number, still JSON",
        before,
        text(`${settled.slice(0, -1)},"extra":1e400}`),
        paid
      ),
      c(
        "a member whose name holds U+0000: a name, still JSON",
        before,
        text(`${settled.slice(0, -1)},"\\u0000extra":1}`),
        paid
      ),
      c(
        "a member holding a lone surrogate: still JSON",
        before,
        text(`${settled.slice(0, -1)},"extra":"\\ud800"}`),
        paid
      ),
      c(
        "64 arrays and objects nested in all: still JSON",
        before,
        text(`${settled.slice(0, -1)},"extra":${"[".repeat(63)}1${"]".repeat(63)}}`),
        paid
      ),
      c(
        "65 arrays and objects nested in all: not JSON",
        before,
        text(`${settled.slice(0, -1)},"extra":${"[".repeat(64)}1${"]".repeat(64)}}`),
        { error: "network" }
      ),
      c(
        "a number with a leading zero: not JSON",
        before,
        text(`${settled.slice(0, -1)},"extra":01}`),
        {
          error: "network"
        }
      ),
      c("a comma after the last member: not JSON", before, text(`${settled.slice(0, -1)},}`), {
        error: "network"
      }),
      c(
        "a no-break space between members: not JSON",
        before,
        text(`${settled.slice(0, -1)},\u00a0"extra":1}`),
        { error: "network" }
      ),
      c(
        "not settled, before the end of the grace period",
        before,
        ok({ settled: false, preimage: null, pr: real.invoice }),
        open
      ),
      c(
        "not settled, after it",
        after,
        ok({ settled: false, preimage: null, pr: real.invoice }),
        expired
      ),
      c("Not found, before", before, error("Not found"), open),
      c("Not found, after", after, error("Not found"), expired),
      c("Not found with HTTP 404, after", after, error("Not found", 404), expired),
      c(
        "status in lower case, after",
        after,
        { status: 200, body: { status: "error", reason: "Not found" } },
        expired
      ),
      c("another refusal, before", before, error("Internal server error"), open),
      c("another refusal, after", after, error("Internal server error"), { error: "network" }),
      c(
        "about another invoice",
        before,
        ok({
          settled: true,
          preimage: real.preimage,
          pr: makeInvoice({ paymentHash: real.paymentHash, timestamp: T })
        }),
        { error: "invalid_invoice" }
      ),
      c("about no invoice", before, ok({ settled: true, preimage: real.preimage }), {
        error: "invalid_invoice"
      }),
      c(
        "a wrong preimage",
        before,
        ok({ settled: true, preimage: "00".repeat(32), pr: real.invoice }),
        { error: "invalid_invoice" }
      ),
      c(
        "a preimage that is not hex",
        before,
        ok({ settled: true, preimage: "zz".repeat(32), pr: real.invoice }),
        { error: "invalid_invoice" }
      ),
      c(
        "settled as a string",
        after,
        ok({ settled: "true", preimage: real.preimage, pr: real.invoice }),
        expired
      ),
      c("HTTP 500", before, { status: 500, bodyText: "oops" }, { error: "network" }),
      c("HTTP 429 with a refusal", before, error("Too many requests", 429), { error: "network" }),
      c("HTTP 200, not JSON", before, { status: 200, bodyText: "<html>" }, { error: "network" }),
      c("HTTP 200, a JSON array", before, { status: 200, body: [] }, { error: "network" }),
      c(
        "HTTP 404, not an LNURL answer",
        after,
        { status: 404, bodyText: "Not found" },
        { error: "network" }
      )
    ],
    stored: storedInvoices()
  };
}

/** Invoices as a shop stores them (SPEC.md §3), checked before a payment check (SPEC.md §22). */
function storedInvoices() {
  const real = appVectors.realInvoice;
  const expiresAt = real.timestamp + real.expirySeconds;
  const sats = String(Number(real.amountMsat) / 1000);
  const address = depositAddress("stored");
  // Every member of an Invoice (SPEC.md §3), in its order.
  const stored = {
    ref: "ORD-1",
    bolt11: real.invoice,
    paymentHash: real.paymentHash,
    verifyUrl: `https://breez.tips/lnurlp/verify/${real.paymentHash}`,
    onchainAddress: null,
    paymentUri: `lightning:${real.invoice}`,
    sats,
    fiat: null,
    rate: null,
    note: "ORD-1",
    createdAt: real.timestamp,
    expiresAt,
    checkoutUrl: null,
    redirectUrl: null
  };
  const without = (name: keyof typeof stored) => {
    const copy: Record<string, unknown> = { ...stored };
    delete copy[name];
    return copy;
  };
  const valid = (name: string, invoice: unknown) => ({ name, invoice, expected: { valid: true } });
  const invalid = (name: string, invoice: unknown) => ({
    name,
    invoice,
    expected: { error: "invalid_order", param: "invoice" }
  });
  const onchainOnly = {
    ...stored,
    bolt11: null,
    paymentHash: null,
    verifyUrl: null,
    onchainAddress: address,
    paymentUri: `bitcoin:${address}?amount=0.00000021`
  };
  const onchainOnlyWithout = (name: "bolt11" | "paymentHash" | "verifyUrl") => {
    const copy: Record<string, unknown> = { ...onchainOnly };
    delete copy[name];
    return copy;
  };
  // A DeclaredInvoice (SPEC.md §3): an Invoice's members but rate, checkoutUrl and redirectUrl,
  // and declaredAt.
  const declared: Record<string, unknown> = { ...stored, declaredAt: real.timestamp + 1 };
  for (const name of ["rate", "checkoutUrl", "redirectUrl"]) delete declared[name];
  return [
    valid("as createInvoice made it", stored),
    valid("a DeclaredInvoice, as findInvoices gives it", declared),
    valid("without an onchainAddress member: Lightning only", without("onchainAddress")),
    valid("sats with a leading zero: a string of digits", { ...stored, sats: `0${sats}` }),
    valid("paid on-chain only, with its ref", onchainOnly),
    valid("with an address and its ref", { ...stored, onchainAddress: address }),
    invalid("without its bolt11 member", without("bolt11")),
    invalid("without its paymentHash member", without("paymentHash")),
    invalid("without its verifyUrl member", without("verifyUrl")),
    // Left out is not null (SPEC.md §2): an order paid on-chain only writes each of them null.
    invalid("paid on-chain only, without its bolt11 member", onchainOnlyWithout("bolt11")),
    invalid(
      "paid on-chain only, without its paymentHash member",
      onchainOnlyWithout("paymentHash")
    ),
    invalid("paid on-chain only, without its verifyUrl member", onchainOnlyWithout("verifyUrl")),
    invalid("bolt11 null with a payment hash", { ...stored, bolt11: null, verifyUrl: null }),
    invalid("neither an invoice nor an address", { ...onchainOnly, onchainAddress: null }),
    invalid("sats as a number", { ...stored, sats: Number(sats) }),
    invalid("sats 0", { ...stored, sats: "0" }),
    invalid("sats that are not the invoice's", { ...stored, sats: String(Number(sats) + 1) }),
    invalid("expiresAt that is not the invoice's", { ...stored, expiresAt: expiresAt + 1 }),
    invalid("expiresAt as a string", { ...stored, expiresAt: String(expiresAt) }),
    invalid("a verify URL in http", {
      ...stored,
      verifyUrl: stored.verifyUrl.replace("https", "http")
    }),
    invalid("a payment hash that is not the invoice's", {
      ...stored,
      paymentHash: "00".repeat(32)
    }),
    invalid("an address that is not a deposit address", {
      ...stored,
      onchainAddress: "bc1qnotanaddress"
    }),
    invalid("an address without its ref", { ...onchainOnly, ref: null }),
    invalid(
      "an address without a ref member",
      (() => {
        const copy: Record<string, unknown> = { ...onchainOnly };
        delete copy.ref;
        return copy;
      })()
    ),
    invalid("an address with a ref that is not a reference", { ...onchainOnly, ref: "ORD 1" }),
    valid("sats of 16 digits, the most", {
      ...onchainOnly,
      sats: "2100000000000000",
      paymentUri: `bitcoin:${address}?amount=21000000`
    }),
    invalid("sats above the most", { ...onchainOnly, sats: "2100000000000001" }),
    invalid("sats of 17 digits, their value 21", { ...onchainOnly, sats: `${"0".repeat(15)}21` })
  ];
}

const REFUSED = { error: "invalid_order", param: "redirectUrl" };

function redirectUrls() {
  const ok = (url: string, shown: string) => ({ url, expected: { shown } });
  const no = (url: string) => ({ url, expected: REFUSED });
  const long = (length: number) => {
    const start = "https://shop.example/";
    return start + "a".repeat(length - start.length);
  };
  return {
    description:
      'Redirect URLs (SPEC.md §30, Checkout links, Redirect URLs): what the page shows of a valid one, after "Redirecting to", or createInvoice\'s error for an order with `checkout: true` and this `redirectUrl`. The page refuses the same ones in a record.',
    cases: [
      ok("https://shop.example/orders/1042/thanks", "shop.example"),
      ok("https://shop.example", "shop.example"),
      ok("https://shop.example?order=1042", "shop.example"),
      ok("https://shop.example#paid", "shop.example"),
      ok("https://shop.example:8443/thanks", "shop.example:8443"),
      ok("https://shop.example:08443/", "shop.example:08443"),
      ok("https://www.shop-1.example.ch/thanks", "www.shop-1.example.ch"),
      ok("https://xn--bcher-kva.example/thanks", "xn--bcher-kva.example"),
      ok("https://shop.example/a%20b?x=%C3%A9&y=%c3%a9", "shop.example"),
      ok("https://shop.example/@other.example", "shop.example"),
      ok("https://shop.example/~me/;p=1?q=a,b&r=[x]&s=$!*'()#!/route", "shop.example"),
      ok(long(2048), "shop.example"),
      ok("myshop://orders/42", "myshop://"),
      ok("myshop://", "myshop://"),
      ok("com.example.shop://paid?order=42", "com.example.shop://"),
      ok("my-shop+v2://x", "my-shop+v2://"),
      // A refused scheme is the whole scheme, never a prefix.
      ok("firefoxshop://orders/42", "firefoxshop://"),
      ok("a://x", "a://"),
      ok(`a${"b".repeat(31)}://x`, `a${"b".repeat(31)}://`),
      no(""),
      no(long(2049)),
      no("http://shop.example/thanks"),
      no("HTTPS://shop.example/"),
      no("https://Shop.example/"),
      no("https://shop.example /thanks"),
      no("https://shop.example/th anks"),
      no("https://shop.example/\tthanks"),
      no("https://shop.example/thanks\n"),
      no(" https://shop.example/"),
      no("https://shop.example\\@evil.example/"),
      no("https://shop.example/\\thanks"),
      no("https://user:pass@shop.example/"),
      no("https://user@shop.example/"),
      no("https://shop.example@evil.example/"),
      no("https://shop.example:8443@evil.example/"),
      no("https://127.0.0.1/thanks"),
      no("https://localhost/thanks"),
      no("https://shop.localhost/thanks"),
      ok("https://localhost.shop.example/thanks", "localhost.shop.example"),
      no("https://[::1]/thanks"),
      no("https://shop.example:0/"),
      no("https://shop.example:65536/"),
      no("https://shop.example:/"),
      no("https://shop.example:123456/"),
      no("https://shop.example./"),
      no("https://shop.e1/"),
      no("https://bücher.example/"),
      no("https://shop.example/bücher"),
      no("https://shop.example/%zz"),
      no("https://shop.example/%2"),
      no('https://shop.example/"x"'),
      no("https://shop.example/<script>"),
      no("https://shop.example/{x}"),
      no("https://shop.example/a|b"),
      no("https://shop.example/a^b"),
      no("https://shop.example/a`b"),
      no("https:shop.example"),
      no("https:/shop.example"),
      no("//shop.example/thanks"),
      no("/thanks"),
      no("shop.example/thanks"),
      no("myshop:orders/42"),
      no("MyShop://x"),
      no("1shop://x"),
      no("my_shop://x"),
      no(`a${"b".repeat(32)}://x`),
      no("javascript://%0Aalert(1)"),
      no("javascript:alert(1)"),
      no("JavaScript://x"),
      no("vbscript://x"),
      no("data://text/html,x"),
      no("data:text/html;base64,PHNjcmlwdD4="),
      no("file:///etc/passwd"),
      no("blob://x"),
      no("about://blank"),
      no("filesystem://x"),
      no("view-source://x"),
      no("chrome://settings"),
      // Other browsers: they open the web page in the rest of the link, whose host is not shown.
      no("x-safari-https://phish.example/login"),
      no("x-safari-http://phish.example/login"),
      no("com-apple-mobilesafari-tab://phish.example/login"),
      no("googlechromes://phish.example/login"),
      no("googlechrome://navigate?url=https://phish.example/login"),
      no("googlechrome-x-callback://x-callback-url/open/?url=https%3A%2F%2Fphish.example%2Flogin"),
      no("firefox://open-url?url=https%3A%2F%2Fphish.example%2Flogin"),
      no("firefox-focus://open-url?url=https%3A%2F%2Fphish.example%2Flogin"),
      no("brave://open-url?url=https%3A%2F%2Fphish.example%2Flogin"),
      no("microsoft-edge://https://phish.example/login"),
      no("microsoft-edge-http://phish.example/login"),
      no("microsoft-edge-https://phish.example/login"),
      no("opera-http://phish.example/login"),
      no("opera-https://phish.example/login"),
      no("ddgquicklink://phish.example/login"),
      no("ddgQuickLink://phish.example/login"),
      no("onionbrowser://phish.example/login"),
      no("onionbrowsers://phish.example/login"),
      no("content://x"),
      no("intent://scan/#Intent;scheme=zxing;end"),
      no("android-app://com.example/https/x"),
      no("ftp://shop.example/x"),
      no("ws://shop.example/x"),
      no("wss://shop.example/x"),
      no("lightning://lnbc1x"),
      no("bitcoin://bc1qx"),
      no("lnurlw://x"),
      no("keyauth://x"),
      no("tel://+41000000000"),
      no("sms://+41000000000"),
      no("mailto://a@shop.example"),
      no("facetime://x"),
      no("itms-services://?action=download-manifest&url=https://x.example/m.plist"),
      no("ms-msdt://x"),
      no("search-ms://x")
    ]
  };
}

/** HKDF-SHA256 of `secret`, 32 bytes, as SPEC.md "Conventions" says: computed here, not by the package. */
function hkdfHex(secret: Uint8Array, salt: string, info: string): string {
  return bytesToHex(hkdf(sha256, secret, utf8ToBytes(salt), utf8ToBytes(info), 32));
}

const CHECKOUT_SALT = "sattle.me/checkout";
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * The base64url of 32 bytes (43 characters, the last one's 2 low bits unused) with its last
 * character's lowest bit set: the same bytes, written as no encoder writes them.
 */
function nonCanonical(text: string): string {
  const last = BASE64URL.indexOf(text.at(-1)!);
  return text.slice(0, -1) + BASE64URL[last | 1];
}
const b64 = (bytes: Uint8Array) => bytesToBase64Url(bytes);
const fill = (seed: number) => new Uint8Array(32).fill(seed);

/** Deposit addresses (SPEC.md §31), those of onchain-addresses.json. */
const ADDRESS_1 = "bc1px22v5j99gdwhxqyelg2p6tdcfajjd3njhzn22c2gura2dvxg2xlqw2wte4";
const ADDRESS_2 = "bc1p4gmh64rd4m5y5nn8hwfnvtz2mm6lngpmwys5a257klyg03ju0pyqu65xe8";
/**
 * The rest keys of the order ORD-1042's invoice with ADDRESS_1 (the real invoice's end), from the
 * app's integration key.
 */
const REST = restKeys(
  hexToBytes(KEY),
  "ORD-1042",
  ADDRESS_1,
  appVectors.realInvoice.timestamp + appVectors.realInvoice.expirySeconds
);
/** ADDRESS_1's program on testnet: not a deposit address. */
const TESTNET_ADDRESS = "tb1px22v5j99gdwhxqyelg2p6tdcfajjd3njhzn22c2gura2dvxg2xlqezcyr6";

function checkoutLinks() {
  const author = bytesToHex(schnorr.getPublicKey(fill(0x11)));
  const linkKey = fill(0x22);
  const relays = ["wss://relay.example", "wss://nos.lol:4443", "wss://relay.example.ch/nostr"];
  const relaysText = hosts("relay.example,nos.lol:4443,relay.example.ch/nostr");
  const fragment = `c.${b64(hexToBytes(author))}.${b64(linkKey)}.${relaysText}`;
  const link = { author, linkKey: bytesToHex(linkKey), relays };
  const f = (name: string, text: string, expected: unknown) => ({
    name,
    fragment: text,
    expected
  });
  // Not the x coordinate of a point: x = 5 has no y on secp256k1 (x³ + 7 is not a square).
  const offCurve = new Uint8Array(32);
  offCurve[31] = 5;

  const real = appVectors.realInvoice;
  const value = {
    version: 1,
    businessName: "Sunrise Bakery",
    invoice: real.invoice,
    verifyUrl: `https://breez.tips/lnurlp/verify/${real.paymentHash}`,
    fiat: { minor: 2, digits: 2, currency: "CHF" },
    note: "Order 1042",
    redirectUrl: "https://shop.example/orders/1042/thanks"
  };
  const shown = {
    sats: "21",
    paymentHash: real.paymentHash,
    onchainAddress: null,
    expiresAt: real.timestamp + real.expirySeconds,
    redirect: "shop.example",
    rest: null
  };
  // Version 2, for an invoice with an address (SPEC.md §31): with the real invoice, or alone.
  const both = {
    ...value,
    version: 2,
    onchainAddress: ADDRESS_1,
    sats: 21,
    createdAt: real.timestamp,
    expiresAt: real.timestamp + real.expirySeconds
  };
  const alone = {
    ...value,
    version: 2,
    invoice: null,
    verifyUrl: null,
    fiat: null,
    onchainAddress: ADDRESS_2,
    sats: 150_000_000,
    createdAt: T + 3280,
    expiresAt: T + 4180
  };
  const v2 = (
    name: string,
    base: Record<string, unknown>,
    changes: Record<string, unknown>,
    expected: unknown
  ) => ({ name: `version 2: ${name}`, value: { ...base, ...changes }, expected });
  const { paymentHash } = preimagePair(7);
  const invoiceOf = (fields: Partial<Parameters<typeof makeInvoice>[0]>) =>
    makeInvoice({
      amountMsat: 21_000n,
      paymentHash,
      timestamp: T,
      expirySeconds: 900,
      ...fields
    });
  const r = (name: string, changes: Record<string, unknown>, expected: unknown) => ({
    name,
    value: { ...value, ...changes },
    expected
  });
  const without = (field: string) => {
    const copy: Record<string, unknown> = { ...value };
    delete copy[field];
    return copy;
  };
  return {
    description:
      'Checkout links (SPEC.md §30, Checkout links). `origins`: the checkout origin a channel\'s `checkout` field gives (null: none). `derivations`: a link key\'s address and encryption key. `urls`: a link\'s URL. `fragments`: what a URL\'s fragment names: a link (`author`, `linkKey`, `relays`), "newer" (a newer format), "invalid", or "other" (not a checkout link). `records`: what the page shows of a record\'s value (its sats, the invoice\'s payment hash (null without one), its on-chain address (null without one), its end, what it shows of the redirect URL, and the rest author and rest key of a record of version 2 that carries them, else null), "newer" or "invalid".',
    origins: [
      { checkout: { origin: "https://pay.example" }, expected: "https://pay.example" },
      { checkout: { origin: "https://pay.example:8443" }, expected: "https://pay.example:8443" },
      {
        checkout: { origin: "https://checkout-1.xn--bcher-kva.example" },
        expected: "https://checkout-1.xn--bcher-kva.example"
      },
      { checkout: { origin: "https://pay.example", more: 1 }, expected: "https://pay.example" },
      { checkout: { origin: "https://pay.example/" }, expected: null },
      { checkout: { origin: "https://pay.example/pay" }, expected: null },
      { checkout: { origin: "https://pay.example?x" }, expected: null },
      { checkout: { origin: "http://pay.example" }, expected: null },
      { checkout: { origin: "https://Pay.example" }, expected: null },
      { checkout: { origin: "https://pay.example:0" }, expected: null },
      { checkout: { origin: "https://localhost" }, expected: null },
      { checkout: { origin: "https://pay.localhost" }, expected: null },
      {
        checkout: { origin: "https://localhost.pay.example" },
        expected: "https://localhost.pay.example"
      },
      { checkout: { origin: "https://user@pay.example" }, expected: null },
      { checkout: { origin: " https://pay.example" }, expected: null },
      { checkout: { origin: 42 }, expected: null },
      { checkout: {}, expected: null },
      { checkout: "https://pay.example", expected: null },
      { checkout: ["https://pay.example"], expected: null },
      { checkout: null, expected: null }
    ],
    derivations: [fill(0x00), linkKey, hexToBytes(KEY)].map((k) => ({
      linkKey: bytesToHex(k),
      address: hkdfHex(k, CHECKOUT_SALT, "address/v1"),
      encryptionKey: hkdfHex(k, CHECKOUT_SALT, "encryption-key/v1")
    })),
    urls: [
      {
        origin: "https://pay.example",
        author,
        linkKey: bytesToHex(linkKey),
        relays,
        url: `https://pay.example/pay#${fragment}`
      },
      {
        origin: "https://pay.example:8443",
        author,
        linkKey: bytesToHex(linkKey),
        relays: ["wss://relay.example"],
        url: `https://pay.example:8443/pay#c.${b64(hexToBytes(author))}.${b64(linkKey)}.${hosts("relay.example")}`
      }
    ],
    fragments: [
      f("a link, with its #", `#${fragment}`, link),
      f("a link, without #", fragment, link),
      f("a newer format", `c2.${fragment.slice(2)}`, "newer"),
      f("another letter", `d.${fragment.slice(2)}`, "newer"),
      f("a newer format, alone", "z9", "newer"),
      f("eight characters", "abcdefgh.x", "newer"),
      f("nine characters: not a checkout link", "abcdefghi.x", "other"),
      f("an upper case marker: not a checkout link", `C.${fragment.slice(2)}`, "other"),
      f(
        "a payment link of the point of sale",
        `${b64(hexToBytes(author))}.${b64(linkKey)}.${relaysText}`,
        "other"
      ),
      f("empty", "", "other"),
      f("c alone", "c", "invalid"),
      f("three parts", `c.${b64(hexToBytes(author))}.${b64(linkKey)}`, "invalid"),
      f("five parts", `${fragment}.x`, "invalid"),
      f("an empty part", `c.${b64(hexToBytes(author))}..${relaysText}`, "invalid"),
      f(
        "padded base64url",
        `c.${b64(hexToBytes(author))}=.${b64(linkKey)}.${relaysText}`,
        "invalid"
      ),
      f(
        "a character of base64, not base64url",
        `c.${b64(hexToBytes(author))}.+${b64(linkKey).slice(1)}.${relaysText}`,
        "invalid"
      ),
      f(
        "non-canonical trailing bits",
        `c.${b64(hexToBytes(author))}.${nonCanonical(b64(linkKey))}.${relaysText}`,
        "invalid"
      ),
      f(
        "a key of 31 bytes",
        `c.${b64(hexToBytes(author))}.${b64(linkKey.slice(1))}.${relaysText}`,
        "invalid"
      ),
      f(
        "an author of 33 bytes",
        `c.${b64(new Uint8Array([0, ...hexToBytes(author)]))}.${b64(linkKey)}.${relaysText}`,
        "invalid"
      ),
      f("an author off the curve", `c.${b64(offCurve)}.${b64(linkKey)}.${relaysText}`, "invalid"),
      f(
        "a relay in upper case",
        `c.${b64(hexToBytes(author))}.${b64(linkKey)}.${hosts("Relay.example")}`,
        "invalid"
      ),
      f(
        "a relay twice",
        `c.${b64(hexToBytes(author))}.${b64(linkKey)}.${hosts("relay.example,relay.example")}`,
        "invalid"
      ),
      f(
        "a relay with wss://",
        `c.${b64(hexToBytes(author))}.${b64(linkKey)}.${hosts("wss://relay.example")}`,
        "invalid"
      ),
      f("no relay", `c.${b64(hexToBytes(author))}.${b64(linkKey)}.`, "invalid")
    ],
    records: [
      r("a link of the real invoice", {}, shown),
      r("an order in sats", { fiat: null }, shown),
      r("without a redirect URL", { redirectUrl: null }, { ...shown, redirect: null }),
      r(
        "an app's link",
        { redirectUrl: "myshop://orders/1042" },
        { ...shown, redirect: "myshop://" }
      ),
      r("the invoice in upper case", { invoice: real.invoice.toUpperCase() }, shown),
      r("more fields", { more: true }, shown),
      r("a price of 8 decimals", { fiat: { minor: 1, digits: 8, currency: "XAU" } }, shown),
      v2("an invoice and an address", both, {}, { ...shown, onchainAddress: ADDRESS_1 }),
      v2(
        "an address only",
        alone,
        {},
        {
          sats: "150000000",
          paymentHash: null,
          onchainAddress: ADDRESS_2,
          expiresAt: T + 4180,
          redirect: "shop.example",
          rest: null
        }
      ),
      v2(
        "the rest author and the rest key",
        both,
        { restAuthor: REST.author, restKey: bytesToHex(REST.key) },
        {
          ...shown,
          onchainAddress: ADDRESS_1,
          rest: { author: REST.author, key: bytesToHex(REST.key) }
        }
      ),
      v2("a rest key without its author", both, { restKey: bytesToHex(REST.key) }, "invalid"),
      v2("a rest author without its key", both, { restAuthor: REST.author }, "invalid"),
      v2(
        "a rest author that is no point of the curve",
        both,
        { restAuthor: "0".repeat(63) + "5", restKey: bytesToHex(REST.key) },
        "invalid"
      ),
      v2(
        "a rest key in upper case",
        both,
        { restAuthor: REST.author, restKey: bytesToHex(REST.key).toUpperCase() },
        "invalid"
      ),
      v2(
        "a rest key of 31 bytes",
        both,
        { restAuthor: REST.author, restKey: bytesToHex(REST.key).slice(2) },
        "invalid"
      ),
      r(
        "rest fields in version 1: ignored",
        { restAuthor: REST.author, restKey: bytesToHex(REST.key) },
        shown
      ),
      v2("an amount that is not the invoice's", both, { sats: 22 }, "invalid"),
      v2("a date that is not the invoice's", both, { createdAt: real.timestamp + 1 }, "invalid"),
      v2(
        "an end that is not the invoice's",
        both,
        { expiresAt: real.timestamp + real.expirySeconds + 1 },
        "invalid"
      ),
      v2("no address", both, { onchainAddress: null }, "invalid"),
      v2("an address in upper case", both, { onchainAddress: ADDRESS_1.toUpperCase() }, "invalid"),
      v2("an address of testnet", both, { onchainAddress: TESTNET_ADDRESS }, "invalid"),
      v2("no invoice, but a verify URL", alone, { verifyUrl: value.verifyUrl }, "invalid"),
      v2("no sats", alone, { sats: undefined }, "invalid"),
      v2("0 sats", alone, { sats: 0 }, "invalid"),
      v2("sats as text", alone, { sats: "150000000" }, "invalid"),
      v2("above 21 000 000 BTC", alone, { sats: 2_100_000_000_000_001 }, "invalid"),
      v2("an end before its date", alone, { expiresAt: T + 3280 }, "invalid"),
      v2("no date", alone, { createdAt: undefined }, "invalid"),
      r("a newer version", { version: 3 }, "newer"),
      r("a newer version, otherwise empty", { version: 3, invoice: null }, "newer"),
      r("no version", { version: undefined }, "invalid"),
      r("version 0", { version: 0 }, "invalid"),
      r("version as text", { version: "1" }, "invalid"),
      r("no business name", { businessName: undefined }, "invalid"),
      r("a business name of spaces", { businessName: " \t " }, "invalid"),
      r(
        "a business name of ASCII whitespace (space, tab, line feed, carriage return)",
        { businessName: " \t\n\r " },
        "invalid"
      ),
      r("a business name of a form feed: not ASCII whitespace", { businessName: "\f" }, shown),
      r("a business name of 201 characters", { businessName: "é".repeat(201) }, "invalid"),
      r("a business name of 200 characters", { businessName: "é".repeat(200) }, shown),
      r("no invoice", { invoice: undefined }, "invalid"),
      r("not an invoice", { invoice: "lnbc1nope" }, "invalid"),
      r("an invoice of another network", { invoice: invoiceOf({ network: "tb" }) }, "invalid"),
      r(
        "an invoice without an amount",
        { invoice: invoiceOf({ amountMsat: undefined }) },
        "invalid"
      ),
      r("an invoice of 0 sats", { invoice: invoiceOf({ amountMsat: 0n }) }, "invalid"),
      r(
        "an invoice of 21 000.5 sats",
        { invoice: invoiceOf({ amountMsat: 21_000_500n }) },
        "invalid"
      ),
      r(
        "another valid invoice",
        { invoice: invoiceOf({}) },
        { ...shown, paymentHash, expiresAt: T + 900 }
      ),
      r("no verify URL", { verifyUrl: undefined }, "invalid"),
      r("a verify URL in http", { verifyUrl: "http://breez.tips/verify" }, "invalid"),
      r(
        "a verify URL on an IP address",
        { verifyUrl: `https://10.0.0.1/lnurlp/verify/${real.paymentHash}` },
        "invalid"
      ),
      r(
        "a verify URL with its host in upper case",
        { verifyUrl: `https://Breez.tips/lnurlp/verify/${real.paymentHash}` },
        "invalid"
      ),
      r("no price", { fiat: undefined }, "invalid"),
      r("a price of 0", { fiat: { minor: 0, digits: 2, currency: "CHF" } }, "invalid"),
      r("a price as text", { fiat: { minor: "2", digits: 2, currency: "CHF" } }, "invalid"),
      r("a price of 9 decimals", { fiat: { minor: 2, digits: 9, currency: "CHF" } }, "invalid"),
      r("a price in SAT", { fiat: { minor: 21, digits: 0, currency: "SAT" } }, "invalid"),
      r("a currency in lower case", { fiat: { minor: 2, digits: 2, currency: "chf" } }, "invalid"),
      r(
        "a price above 2^53 − 1",
        { fiat: { minor: 9_007_199_254_740_992, digits: 2, currency: "CHF" } },
        "invalid"
      ),
      r("no note", { note: undefined }, "invalid"),
      r("an empty note", { note: "" }, "invalid"),
      r("a note of 101 characters", { note: "é".repeat(101) }, "invalid"),
      r("a note of 100 characters", { note: "é".repeat(100) }, shown),
      r("a note with a line feed", { note: "Order\n1042" }, "invalid"),
      r("a note holding a lone surrogate", { note: "Order \ud800" }, "invalid"),
      r("a note holding a pair of surrogates (an emoji)", { note: "Order \u{1f600}" }, shown),
      { name: "no redirect URL field", value: without("redirectUrl"), expected: "invalid" },
      r("a refused redirect URL", { redirectUrl: "http://shop.example/thanks" }, "invalid"),
      r("a redirect URL to a wallet", { redirectUrl: "lightning://lnbc1x" }, "invalid"),
      { name: "not an object", value: [value], expected: "invalid" },
      { name: "null", value: null, expected: "invalid" }
    ].map((c) => ({
      ...c,
      // As JSON: a field set to undefined is absent.
      value: c.value === null ? null : (JSON.parse(JSON.stringify(c.value)) as unknown)
    }))
  };
}

const INVALID_RATE_SOURCE = { error: "invalid_option", param: "rateSource" };

/** SPEC.md §26, "Which sources" and "A list". */
function rateSources() {
  const all = ["coingecko", "mempool", "coinbase", "kraken", "opennode"];
  const value = (name: string, rateSource: unknown, sources: string[] | null) => ({
    name,
    rateSource,
    expected: sources ? { sources } : INVALID_RATE_SOURCE
  });
  const quote = (price: string, time: number | null = null) => ({ price, time });
  const rate = (source: string, price: string, asked: string[]) => ({ source, price, asked });
  const failed = (error: string, asked: string[]) => ({ error, asked });
  return {
    description:
      'Rate sources (SPEC.md §26, Rate sources). `statuses`: the error of a source that answers with an HTTP status other than 2xx (a redirect is no answer, SPEC.md §15). `default`: the list a client without `rateSource` asks, in order. `values`: a client\'s `rateSource` (absent when the case has none) and the sources it names, in the order they are asked, or the error; an order\'s `rateSource` gives `invalid_order` instead, and an order without one asks the client\'s. `lists`: the sources of a list asked one at a time for a price in `currency` at `now`, each doing what `answers` says: raise an error ("network", "rate", "unsupported_currency") or give a price, checked as SPEC.md §25 says (invalid, too old or too far ahead: "rate"). Expected: the source whose price is the rate, the RateInfo\'s `price`, and the sources asked, in order; or the error.',
    statuses: [301, 302, 400, 403, 404, 408, 418, 429, 499, 500, 502, 503, 599, 600, 999].map(
      (status) => ({
        status,
        expected: {
          error:
            (status >= 300 && status < 400) ||
            (status >= 500 && status <= 599) ||
            status === 408 ||
            status === 429
              ? "network"
              : "rate"
        }
      })
    ),
    default: all,
    values: [
      { name: "absent: the default list", expected: { sources: all } },
      value("a name", "kraken", ["kraken"]),
      value("another name", "opennode", ["opennode"]),
      value("a list of one", ["coingecko"], ["coingecko"]),
      value("a list, its order kept", ["kraken", "coingecko"], ["kraken", "coingecko"]),
      value("every name, the other way round", [...all].reverse(), [...all].reverse()),
      value("an empty list", [], null),
      value("a name twice", ["coingecko", "mempool", "coingecko"], null),
      value("an unknown name", "coinmarketcap", null),
      value("a name in another case", "CoinGecko", null),
      value("custom: a function, never a name", "custom", null),
      value("an empty string", "", null),
      value("names in one string", "coingecko,mempool", null),
      value("a list with an unknown name", ["coingecko", "bitstamp"], null),
      value("a list inside a list", [["coingecko"]], null),
      value("null", null, null),
      value("a number", 1, null),
      value("an object", { name: "coingecko" }, null)
    ],
    lists: {
      currency: "CHF",
      now: T,
      cases: [
        {
          name: "the first source gives the rate: no other is asked",
          sources: ["coingecko", "mempool"],
          answers: { coingecko: quote("69012.5", T - 60), mempool: quote("70000", T) },
          expected: rate("coingecko", "69012.5", ["coingecko"])
        },
        {
          name: "the first source does not answer: the next one",
          sources: ["coingecko", "mempool"],
          answers: { coingecko: "network", mempool: quote("69012.50", T - 30) },
          expected: rate("mempool", "69012.5", ["coingecko", "mempool"])
        },
        {
          name: "an invalid answer: the next one",
          sources: ["coingecko", "mempool"],
          answers: { coingecko: "rate", mempool: quote("69012", T) },
          expected: rate("mempool", "69012", ["coingecko", "mempool"])
        },
        {
          name: "no price in the currency: the next one",
          sources: ["mempool", "coinbase"],
          answers: { mempool: "unsupported_currency", coinbase: quote("68990.123456789") },
          expected: rate("coinbase", "68990.123456789", ["mempool", "coinbase"])
        },
        {
          name: "a price older than an hour: the next one",
          sources: ["coingecko", "kraken"],
          answers: { coingecko: quote("69000", T - 3601), kraken: quote("69010.1") },
          expected: rate("kraken", "69010.1", ["coingecko", "kraken"])
        },
        {
          name: "a price an hour old: kept",
          sources: ["coingecko", "kraken"],
          answers: { coingecko: quote("69000", T - 3600), kraken: quote("69010.1") },
          expected: rate("coingecko", "69000", ["coingecko"])
        },
        {
          name: "a price dated too far ahead: the next one",
          sources: ["coingecko", "mempool"],
          answers: { coingecko: quote("69000", T + 301), mempool: quote("69001", T) },
          expected: rate("mempool", "69001", ["coingecko", "mempool"])
        },
        {
          name: "a price of zero: the next one",
          sources: ["coinbase", "kraken"],
          answers: { coinbase: quote("0"), kraken: quote("69010.1") },
          expected: rate("kraken", "69010.1", ["coinbase", "kraken"])
        },
        {
          name: "a price that is not a decimal: the next one",
          sources: ["coinbase", "opennode"],
          answers: { coinbase: quote("-69000"), opennode: quote("6.9e4") },
          expected: rate("opennode", "69000", ["coinbase", "opennode"])
        },
        {
          name: "the default list, every source down but the last",
          sources: all,
          answers: {
            coingecko: "network",
            mempool: "network",
            coinbase: "rate",
            kraken: "unsupported_currency",
            opennode: quote("69000.50")
          },
          expected: rate("opennode", "69000.5", all)
        },
        {
          name: "the list's order, not the default one's",
          sources: ["kraken", "coingecko"],
          answers: { kraken: quote("69010.1"), coingecko: quote("69012.5", T) },
          expected: rate("kraken", "69010.1", ["kraken"])
        },
        {
          name: "one source: its error, no other asked",
          sources: ["kraken"],
          answers: { kraken: "network", coingecko: quote("69012.5", T) },
          expected: failed("network", ["kraken"])
        },
        {
          name: "one source without the currency",
          sources: ["mempool"],
          answers: { mempool: "unsupported_currency" },
          expected: failed("unsupported_currency", ["mempool"])
        },
        {
          name: "no source has the currency",
          sources: ["coingecko", "coinbase", "opennode"],
          answers: {
            coingecko: "unsupported_currency",
            coinbase: "unsupported_currency",
            opennode: "unsupported_currency"
          },
          expected: failed("unsupported_currency", ["coingecko", "coinbase", "opennode"])
        },
        {
          name: "no price: the last error that is not unsupported_currency",
          sources: ["coingecko", "mempool", "coinbase"],
          answers: { coingecko: "network", mempool: "rate", coinbase: "unsupported_currency" },
          expected: failed("rate", ["coingecko", "mempool", "coinbase"])
        },
        {
          name: "no price: a network error last",
          sources: ["coingecko", "mempool"],
          answers: { coingecko: "rate", mempool: "network" },
          expected: failed("network", ["coingecko", "mempool"])
        },
        {
          name: "no price: a network error between two without the currency",
          sources: ["coingecko", "mempool", "kraken"],
          answers: {
            coingecko: "unsupported_currency",
            mempool: "network",
            kraken: "unsupported_currency"
          },
          expected: failed("network", ["coingecko", "mempool", "kraken"])
        }
      ]
    }
  };
}

/** Every vector file, by name. */
export function specVectors(): Record<string, unknown> {
  return {
    "integration-keys.json": integrationKeys(),
    "relay-urls.json": relayUrls(),
    "bolt11.json": bolt11(),
    "fiat.json": fiat(),
    "prices.json": prices(),
    "conversions.json": conversions(),
    "rate-sources.json": rateSources(),
    "order-text.json": orderText(),
    "invoice-checks.json": invoiceChecks(),
    "payments.json": payments(),
    "redirect-urls.json": redirectUrls(),
    "checkout-links.json": checkoutLinks()
  };
}
