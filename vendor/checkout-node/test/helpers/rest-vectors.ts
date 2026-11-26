/**
 * The vectors of the rest of an on-chain underpayment (SPEC.md, "The rest of an underpayment"),
 * vectors/onchain-rests.json: the rest keys of an order's invoice (its address and end), rest records (made with
 * fixed random bytes) and what the page reads of them, declarations with `rest` opened as the
 * sale, and when a check asks for an invoice of the rest. The keys and the events are made by this
 * package; the expectations are written by hand from SPEC.md, and checkout-spec's CI computes the
 * keys and opens the events again with an implementation of its own.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import { declarationEvent, registryOf } from "../../src/declaration.js";
import { acceptanceRecordAddress, restKeys, restRecordAddress, saleOf } from "../../src/derive.js";
import type { NostrEvent } from "../../src/nostr/event.js";
import { sealRecord } from "../../src/nostr/record.js";
import { acceptanceRecordEvent } from "../../src/onchain/acceptance.js";
import { restRecordEvent } from "../../src/onchain/rest.js";
import type { RandomBytes } from "../../src/random.js";

import { makeInvoice, metadataHash, preimagePair } from "./lightning.js";
import { appVectors } from "./vectors.js";

/** Random bytes from a counter: the same events, byte for byte, at every run. */
export function fixedRandom(label: string): RandomBytes {
  let counter = 0;
  return (length) => {
    const out = new Uint8Array(length);
    for (let filled = 0; filled < length; filled += 32) {
      const block = sha256(concatBytes(utf8ToBytes(label), new Uint8Array([counter++])));
      out.set(block.subarray(0, Math.min(32, length - filled)), filled);
    }
    return out;
  };
}

/**
 * A record whose content is of a newer NIP-44 version (`#`), at `d`, dated `createdAt`, signed by
 * the rest secret with `sig`: the specification signed these two with auxiliary random bytes this
 * module does not draw, so their signatures are taken as they are (BIP-340: any of them verifies).
 * With `forged`, the copy a relay could send without the rest secret: a second later, its id its
 * hash, the same signature.
 */
function newerContent(
  author: string,
  d: string,
  createdAt: number,
  sig: string,
  forged = false
): NostrEvent {
  const template = {
    pubkey: author,
    created_at: createdAt + (forged ? 1 : 0),
    kind: 30078,
    tags: [
      ["d", d],
      ["expiration", String(END + 604_800)]
    ],
    content: "#"
  };
  const { pubkey, created_at, kind, tags, content } = template;
  const id = bytesToHex(
    sha256(utf8ToBytes(JSON.stringify([0, pubkey, created_at, kind, tags, content])))
  );
  return { id, ...template, sig };
}
const NEWER_RECORD_SIG =
  "9ddb7a7b06ebb225fb9817b89a0fe6498cd72d39bf93edf3215854f0b7082f1b9c09bc9a7cd7b06ee51a83e6ba66cd0cf2426730f9c66cf5d6c0b14f091ccc98";
const NEWER_ACCEPTANCE_SIG =
  "ef9307d2e271232226c56c878434920fa76dab9474ceb9c73c33ba665514170518b422ccea79e6cf5fe2167e14f5d83a3a7c47bc232444f8e6af08075e14ae8a";

const KEY = hexToBytes(appVectors.parsed.integrationKey);
const ADDRESS = "bc1px22v5j99gdwhxqyelg2p6tdcfajjd3njhzn22c2gura2dvxg2xlqw2wte4";
const OTHER_ADDRESS = "bc1p4gmh64rd4m5y5nn8hwfnvtz2mm6lngpmwys5a257klyg03ju0pyqu65xe8";
const TESTNET_ADDRESS = "tb1px22v5j99gdwhxqyelg2p6tdcfajjd3njhzn22c2gura2dvxg2xlqezcyr6";
const REF = "ORD-1042";
/** The order's invoice: 49 000 sats, from T to T + 900. */
const T = 1791378280;
const END = T + 900;
const DESCRIPTION = metadataHash('[["text/identifier","shop@breez.tips"]]');

function keyCase(ref: string, address: string, expiresAt: number, hashes: string[]) {
  const keys = restKeys(KEY, ref, address, expiresAt);
  return {
    ref,
    address,
    expiresAt,
    restKey: bytesToHex(keys.key),
    restSecret: bytesToHex(keys.secretKey),
    restAuthor: keys.author,
    restEncryptionKey: bytesToHex(keys.encryptionKey),
    records: hashes.map((paymentHash) => ({
      paymentHash,
      address: restRecordAddress(keys.key, paymentHash)
    })),
    acceptanceAddress: acceptanceRecordAddress(keys.key)
  };
}

/** An invoice of the rest: `sats`, from `timestamp`, lasting `expiry`. */
function restInvoice(
  seed: number,
  sats: bigint,
  timestamp: number,
  expiry: number,
  network = "bc"
) {
  const { paymentHash } = preimagePair(seed);
  return {
    pr: makeInvoice({
      amountMsat: sats * 1000n,
      network,
      paymentHash,
      descriptionHash: DESCRIPTION,
      timestamp,
      expirySeconds: expiry
    }),
    paymentHash,
    verify: `https://breez.tips/lnurlp/verify/${paymentHash}`
  };
}

function records() {
  const keys = restKeys(KEY, REF, ADDRESS, END);
  const random = fixedRandom("onchain-rests records");
  const at = T + 300;
  const valid = restInvoice(41, 29_000n, at, END - at);
  const event = (
    invoice: { pr: string; verify: string; paymentHash: string },
    changes: {
      value?: Record<string, unknown>;
      type?: string;
      signer?: Uint8Array;
      encryptionKey?: Uint8Array;
      address?: string;
    } = {}
  ) =>
    changes.value || changes.type || changes.signer || changes.encryptionKey || changes.address
      ? sealRecord({
          type: changes.type ?? "checkout-rest",
          value: changes.value ?? { version: 1, invoice: invoice.pr, verifyUrl: invoice.verify },
          signer: changes.signer ?? keys.secretKey,
          encryptionKey: changes.encryptionKey ?? keys.encryptionKey,
          address: changes.address ?? restRecordAddress(keys.key, invoice.paymentHash),
          createdAt: at,
          tags: [["expiration", String(END + 604_800)]],
          random
        })
      : restRecordEvent({
          keys,
          invoice: {
            bolt11: invoice.pr,
            verifyUrl: invoice.verify,
            paymentHash: invoice.paymentHash
          },
          expiresAt: END,
          createdAt: at,
          random
        });
  const read = (invoice: { pr: string; verify: string; paymentHash: string }, sats: number) => ({
    invoice: invoice.pr,
    paymentHash: invoice.paymentHash,
    verifyUrl: invoice.verify,
    sats: String(sats)
  });
  const c = (name: string, value: unknown, expected: unknown) => ({ name, event: value, expected });
  const lastSecond = restInvoice(42, 29_000n, at, END + 300 - at);
  const tooLate = restInvoice(43, 29_000n, at, END + 301 - at);
  const early = restInvoice(44, 29_000n, T - 300, 600);
  const tooEarly = restInvoice(45, 29_000n, T - 301, 600);
  const whole = restInvoice(46, 49_000n, at, END - at);
  const one = restInvoice(47, 1n, at, END - at);
  const testnet = restInvoice(48, 29_000n, at, END - at, "tb");
  const partSat = {
    ...valid,
    pr: makeInvoice({
      amountMsat: 29_000_500n,
      paymentHash: valid.paymentHash,
      descriptionHash: DESCRIPTION,
      timestamp: at,
      expirySeconds: END - at
    })
  };
  const other = restKeys(KEY, REF, OTHER_ADDRESS, END);
  const validAddress = restRecordAddress(keys.key, valid.paymentHash);
  return {
    restKey: bytesToHex(keys.key),
    restAuthor: keys.author,
    link: { sats: "49000", createdAt: T, expiresAt: END },
    cases: [
      c("an invoice of the rest", event(valid), read(valid, 29_000)),
      c("ending 300 s after the link's end", event(lastSecond), read(lastSecond, 29_000)),
      c("ending 301 s after the link's end", event(tooLate), null),
      c("dated 300 s before the link's date", event(early), read(early, 29_000)),
      c("dated 301 s before the link's date", event(tooEarly), null),
      c("1 sat", event(one), read(one, 1)),
      c("the link's whole amount", event(whole), null),
      c("an amount in a fraction of a sat", event(partSat), null),
      c("an invoice of testnet", event(testnet), null),
      c(
        "a verify URL in http",
        event(valid, {
          value: { version: 1, invoice: valid.pr, verifyUrl: "http://breez.tips/verify" }
        }),
        null
      ),
      c(
        "a newer version",
        event(valid, { value: { version: 2, invoice: valid.pr, verifyUrl: valid.verify } }),
        "newer"
      ),
      // Of a newer format only once its event checks out (SPEC.md §12).
      c(
        "a content of a newer NIP-44 version (#), its event checking out",
        newerContent(keys.author, validAddress, at + 10, NEWER_RECORD_SIG),
        "newer"
      ),
      c(
        "the same sent by a relay without the rest secret: its id the hash, not its signature",
        newerContent(keys.author, validAddress, at + 10, NEWER_RECORD_SIG, true),
        null
      ),
      // The read of rest records also returns the link's acceptance record (same author).
      c(
        "the link's acceptance record (same author, at the acceptance record address): no rest record",
        acceptances().cases[0]!.event,
        null
      ),
      c("the link's acceptance record of a newer format: no rest record", newerAcceptance(), null),
      c(
        "no version",
        event(valid, { value: { invoice: valid.pr, verifyUrl: valid.verify } }),
        null
      ),
      c(
        "more fields",
        event(valid, {
          value: { version: 1, invoice: valid.pr, verifyUrl: valid.verify, more: true }
        }),
        read(valid, 29_000)
      ),
      c("another type", event(valid, { type: "checkout" }), null),
      c("signed by another order's rest secret", event(valid, { signer: other.secretKey }), null),
      c(
        "sealed with another order's key",
        event(valid, { encryptionKey: other.encryptionKey }),
        null
      ),
      c(
        "at the address of another invoice",
        event(valid, { address: restRecordAddress(keys.key, preimagePair(49).paymentHash) }),
        null
      ),
      c("tampered", { ...event(valid), created_at: at + 1 }, null)
    ]
  };
}

/** An acceptance record of the invoice of ORD-1042 whose content is of a newer NIP-44 version. */
function newerAcceptance(forged = false): NostrEvent {
  const keys = restKeys(KEY, REF, ADDRESS, END);
  return newerContent(
    keys.author,
    acceptanceRecordAddress(keys.key),
    T + 410,
    NEWER_ACCEPTANCE_SIG,
    forged
  );
}

/**
 * Acceptance records of the invoice of the order ORD-1042 (SPEC.md, "Acceptance records"), as the
 * page of a checkout link of it reads them: what was received, "newer" or null.
 */
function acceptances() {
  const keys = restKeys(KEY, REF, ADDRESS, END);
  const random = fixedRandom("onchain-rests acceptances");
  const at = T + 400;
  const event = (
    received: number,
    changes: {
      value?: Record<string, unknown>;
      type?: string;
      signer?: Uint8Array;
      encryptionKey?: Uint8Array;
      address?: string;
    } = {}
  ) =>
    changes.value || changes.type || changes.signer || changes.encryptionKey || changes.address
      ? sealRecord({
          type: changes.type ?? "checkout-accepted",
          value: changes.value ?? { version: 1, received },
          signer: changes.signer ?? keys.secretKey,
          encryptionKey: changes.encryptionKey ?? keys.encryptionKey,
          address: changes.address ?? acceptanceRecordAddress(keys.key),
          createdAt: at,
          tags: [["expiration", String(END + 604_800)]],
          random
        })
      : acceptanceRecordEvent({
          keys,
          received: BigInt(received),
          expiresAt: END,
          createdAt: at,
          random
        });
  const c = (name: string, value: unknown, expected: unknown) => ({ name, event: value, expected });
  const other = restKeys(KEY, REF, OTHER_ADDRESS, END);
  return {
    restKey: bytesToHex(keys.key),
    restAuthor: keys.author,
    link: { sats: "49000" },
    cases: [
      c("a payment accepted", event(46_550), { received: "46550" }),
      c("1 sat", event(1), { received: "1" }),
      c("1 sat below the link's amount", event(48_999), { received: "48999" }),
      c("the link's whole amount", event(49_000), null),
      c("0 sats", event(0), null),
      c("a fraction of a sat", event(46_550, { value: { version: 1, received: 46_550.5 } }), null),
      c("a string", event(46_550, { value: { version: 1, received: "46550" } }), null),
      c("a newer version", event(46_550, { value: { version: 2, received: 46_550 } }), "newer"),
      c(
        "a content of a newer NIP-44 version (#), its event checking out",
        newerAcceptance(),
        "newer"
      ),
      c(
        "the same sent by a relay without the rest secret: its id the hash, not its signature",
        newerAcceptance(true),
        null
      ),
      c("no version", event(46_550, { value: { received: 46_550 } }), null),
      c("more fields", event(46_550, { value: { version: 1, received: 46_550, more: true } }), {
        received: "46550"
      }),
      c("another type", event(46_550, { type: "checkout-rest" }), null),
      c("signed by another order's rest secret", event(46_550, { signer: other.secretKey }), null),
      c(
        "sealed with another order's key",
        event(46_550, { encryptionKey: other.encryptionKey }),
        null
      ),
      c(
        "at the address of another invoice",
        event(46_550, { address: acceptanceRecordAddress(other.key) }),
        null
      ),
      c("tampered", { ...event(46_550), created_at: at + 1 }, null)
    ]
  };
}

function declarations() {
  const channel = appVectors.channel.value.v as Record<string, unknown>;
  const registry = registryOf(channel.registryKey as string, channel.registryReader as string);
  const sale = saleOf(KEY, registry, REF);
  const random = fixedRandom("onchain-rests declarations");
  const invoice = restInvoice(51, 29_000n, T + 300, 600);
  const event = (rest: unknown) =>
    declarationEvent({
      sale,
      invoice: invoice.pr,
      verifyUrl: invoice.verify,
      paymentHash: invoice.paymentHash,
      price: { minor: 2450, digits: 2, currency: "CHF" },
      note: "Order 1042",
      createdAt: T + 300,
      ...(rest === undefined ? {} : { rest: rest as { address: string; expiresAt: number } }),
      random
    });
  const opened = (rest: { address: string; expiresAt: number } | null) => ({
    invoice: invoice.pr,
    note: "Order 1042",
    rest
  });
  const of = { address: ADDRESS, expiresAt: END };
  return {
    ref: REF,
    registryKey: channel.registryKey,
    registryReader: channel.registryReader,
    cases: [
      {
        name: "the declaration of an invoice of the rest",
        event: event(of),
        expected: opened(of)
      },
      {
        name: "more fields in `rest`",
        event: event({ ...of, more: true }),
        expected: opened(of)
      },
      { name: "an invoice of the order", event: event(undefined), expected: opened(null) },
      { name: "`rest` null", event: event(null), expected: null },
      { name: "`rest` an address alone", event: event(ADDRESS), expected: null },
      {
        name: "`rest` an address of testnet",
        event: event({ ...of, address: TESTNET_ADDRESS }),
        expected: null
      },
      {
        name: "`rest` in upper case",
        event: event({ ...of, address: ADDRESS.toUpperCase() }),
        expected: null
      },
      { name: "`rest` without an end", event: event({ address: ADDRESS }), expected: null },
      {
        name: "`rest` ending in a fraction of a second",
        event: event({ ...of, expiresAt: END + 0.5 }),
        expected: null
      },
      {
        name: "`rest` ending as a string",
        event: event({ ...of, expiresAt: String(END) }),
        expected: null
      },
      { name: "`rest` ending before 1970", event: event({ ...of, expiresAt: -1 }), expected: null }
    ]
  };
}

function asking() {
  const E = END;
  const base = {
    sats: "49000",
    expiresAt: E,
    now: T + 300,
    received: "20000",
    rests: [] as {
      id: string;
      paymentHash: string;
      sats: string;
      createdAt: number;
      expiresAt: number;
      paid: boolean;
    }[],
    lease: { sats: "49000", expiresAt: E } as { sats: string; expiresAt: number } | null,
    sendable: { min: "1", max: "1000000" }
  };
  // Its payment hash: SHA-256 of its id.
  const rest = (id: string, sats: number, createdAt: number, expiresAt = E, paid = false) => ({
    id,
    paymentHash: bytesToHex(sha256(utf8ToBytes(id))),
    sats: String(sats),
    createdAt,
    expiresAt,
    paid
  });
  const ask = (sats: number, now = base.now) => ({ sats: String(sats), expirySeconds: E - now });
  const c = (name: string, changes: Partial<typeof base>, expected: unknown) => ({
    name,
    ...base,
    ...changes,
    expected
  });
  return [
    c(
      "underpaid, no invoice of the rest yet",
      {},
      { rest: { sats: "29000", invoice: null }, ask: ask(29_000) }
    ),
    c(
      "an invoice of exactly the rest",
      { rests: [rest("a", 29_000, T + 200)] },
      { rest: { sats: "29000", invoice: "a" }, ask: null }
    ),
    c(
      "an invoice of an earlier rest",
      { rests: [rest("a", 39_000, T + 100)] },
      { rest: { sats: "29000", invoice: null }, ask: ask(29_000) }
    ),
    c(
      "an invoice of the rest that ended",
      { rests: [rest("a", 29_000, T + 100, T + 300)] },
      { rest: { sats: "29000", invoice: null }, ask: ask(29_000) }
    ),
    c(
      "two invoices of the rest: the latest",
      { rests: [rest("b", 29_000, T + 250), rest("a", 29_000, T + 200)] },
      { rest: { sats: "29000", invoice: "b" }, ask: null }
    ),
    c(
      // SHA-256 of "a" (ca97…) is above that of "b" (3e23…).
      "two invoices of the rest of one date: the greater payment hash",
      { rests: [rest("a", 29_000, T + 200), rest("b", 29_000, T + 200)] },
      { rest: { sats: "29000", invoice: "a" }, ask: null }
    ),
    c(
      "an invoice of the rest paid, the rest paid by another one",
      { received: "49000", rests: [rest("a", 29_000, T + 200, E, true)] },
      { rest: null, ask: null }
    ),
    c(
      "60 s left",
      { now: E - 60 },
      { rest: { sats: "29000", invoice: null }, ask: ask(29_000, E - 60) }
    ),
    c("59 s left", { now: E - 59 }, { rest: { sats: "29000", invoice: null }, ask: null }),
    c("the invoice's end", { now: E }, { rest: null, ask: null }),
    c("nothing received", { received: "0" }, { rest: null, ask: null }),
    c(
      "no lease of the address",
      { lease: null },
      { rest: { sats: "29000", invoice: null }, ask: null }
    ),
    c(
      "a lease of another amount",
      { lease: { sats: "48000", expiresAt: E } },
      { rest: { sats: "29000", invoice: null }, ask: null }
    ),
    c(
      "a lease of another end",
      { lease: { sats: "49000", expiresAt: E + 1 } },
      { rest: { sats: "29000", invoice: null }, ask: null }
    ),
    c(
      "the rest above the Lightning address's maximum",
      { sendable: { min: "1", max: "28999" } },
      { rest: { sats: "29000", invoice: null }, ask: null }
    ),
    c(
      "the rest below the Lightning address's minimum",
      { sendable: { min: "29001", max: "1000000" } },
      { rest: { sats: "29000", invoice: null }, ask: null }
    ),
    c(
      "the rest at the Lightning address's bounds",
      { sendable: { min: "29000", max: "29000" } },
      { rest: { sats: "29000", invoice: null }, ask: ask(29_000) }
    ),
    c("a rest of 1 sat", { received: "48999" }, { rest: { sats: "1", invoice: null }, ask: ask(1) })
  ];
}

export function onchainRests() {
  const valid = restInvoice(41, 29_000n, T + 300, END - (T + 300));
  return {
    description:
      "The rest of an on-chain underpayment (SPEC.md §31, The rest of an underpayment). `keys`: the rest key, secret, author and encryption key of an order's (`ref`) invoice with a deposit address (`address`) and an end (`expiresAt`), from `integrationKey` (the app's vector's), the rest record address of each payment hash, and the acceptance record address (SPEC.md §31, Acceptance records). `records`: rest records of the invoice `link` of the order ORD-1042 (the first of `keys`), made with fixed random bytes, as the page of a checkout link of the invoice `link` reads them with `restKey` and `restAuthor`: the invoice it shows (its payment hash, verify URL and sats), \"newer\" (left aside) or null (ignored). `acceptances`: acceptance records of that invoice, made with fixed random bytes, as the page of a checkout link of an invoice of `link`'s `sats` reads them: what was received (`received`), \"newer\" (left aside) or null (ignored). `declarations`: declarations of the sale of `ref` (the app's registry), opened as the sale: its invoice, note and `rest` (the invoice it is the rest of: its deposit address and end; null for an invoice of the order), or null (not a declaration of the sale). `asking`: a check of an invoice (`sats`, `expiresAt`) at `now`, which received `received` in time, with the rest invoices the relays hold (`rests`: `id`, payment hash, amount, date, end, and whether it is paid), the sale's lease of the address (`lease`, null without one) and the Lightning address's sendable sats: its `rest` (what is left, and the rest invoice of exactly that, by `id`; null when it has none), and the invoice it asks for (`ask`: its sats and expiry; null when it asks none). A record is of a newer format (\"newer\") only once its event checks out (SPEC.md §12): one that a relay sends without the rest secret's signature is nothing.",
    integrationKey: appVectors.parsed.integrationKey,
    keys: [
      keyCase(REF, ADDRESS, END, [valid.paymentHash, preimagePair(49).paymentHash]),
      keyCase(REF, OTHER_ADDRESS, END, [valid.paymentHash]),
      keyCase("ORD-1043", ADDRESS, END, [valid.paymentHash]),
      // Another invoice of the order that leased the same address later: keys of its own.
      keyCase(REF, ADDRESS, END + 3600, [valid.paymentHash])
    ],
    records: records(),
    acceptances: acceptances(),
    declarations: declarations(),
    asking: asking()
  };
}
