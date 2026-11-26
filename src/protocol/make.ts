import { bytesToHex } from "@noble/hashes/utils.js";

import { currencyDigits } from "../../vendor/checkout-node/src/currencies.js";
import { fetchPayRequest, sendableSats } from "../../vendor/checkout-node/src/lnurl.js";
import { publicKeyOf } from "../../vendor/checkout-node/src/nostr/event.js";
import { majority } from "../../vendor/checkout-node/src/nostr/relay.js";
import { recordNodeFor } from "../../vendor/checkout-node/src/onchain/node.js";

import {
  invoiceTotals,
  isPayable,
  isValidLine,
  type InvoiceLine,
  type InvoiceTotals
} from "./amounts.js";
import { invoicingOf, readChannel, type Channel } from "./channel.js";
import {
  INVOICE_VERSION,
  INVOICE_WORDS,
  LIGHTNING_MARGIN_PERCENT,
  LINK_RECORD_VERSION,
  LINK_VERSION,
  MAX_INVOICE_TEXT,
  MAX_LINES,
  MAX_LINK_TEXT,
  type Language
} from "./constants.js";
import type { Call } from "./context.js";
import { takeNumber } from "./counter.js";
import { dayAt, dueRange, endOfDay, isCalendarDate, isTimeZone } from "./dates.js";
import { AssistantError } from "./errors.js";
import {
  formatInvoiceNumber,
  invoiceEvent,
  isRecipient,
  isRedirectUrl,
  type Invoice,
  type InvoiceRecipient
} from "./invoice.js";
import type { AssistantKey } from "./key.js";
import type { AssistantKeys } from "./keys.js";
import {
  assistantTakerTag,
  linkEvent,
  linkRecordEvent,
  linkSale,
  linkUrl,
  newLinkSecret,
  sealedLinkSecret,
  type LinkPayload
} from "./link.js";
import { takeAddress } from "./lot.js";
import { PointBook, pointHour, satsAt } from "./points.js";
import { isText } from "./text.js";

/*
 * Making an invoice (SPEC.md §13): checked whole before anything is taken, then a deposit address
 * (when the merchant takes on-chain payments), a number of the merchant's series, the payment link,
 * its record for the merchant's app, and the invoice, in this order. The caller makes one at a time
 * for a key (SPEC.md §17).
 */

/** What an invoice is made of: the account gives its currency, the business and the link. */
export type InvoiceRequest = {
  recipient: InvoiceRecipient;
  lines: InvoiceLine[];
  /** `YYYY-MM-DD`, from the next day to 9 months later in `timeZone`. */
  dueDate: string;
  terms: string;
  legal: string;
  redirectUrl: string | null;
  /** The invoice's language: the word of the link's note. */
  language: Language;
  /** IANA: where the due date ends (the merchant's), and where "today" is. */
  timeZone: string;
};

export type MadeInvoice = {
  invoice: Invoice;
  totals: InvoiceTotals;
  /** « 2026-0042 ». */
  number: string;
  /** What the payer opens. */
  url: string;
  /** The deposit address the link offers, null when paid over Lightning only. */
  onchainAddress: string | null;
  channel: Channel;
};

/** What is off in `request` for an invoice in a currency of `digits` digits; empty when nothing. */
export function invoiceProblems(request: InvoiceRequest, digits: number, now: number): string[] {
  const problems: string[] = [];
  if (!isRecipient(request.recipient)) problems.push("recipient");
  if (!Array.isArray(request.lines) || request.lines.length === 0) {
    problems.push("lines: at least one");
  } else if (request.lines.length > MAX_LINES) {
    problems.push(`lines: at most ${MAX_LINES}`);
  } else {
    request.lines.forEach((line, index) => {
      if (!isValidLine(line, digits)) problems.push(`lines[${index}]`);
    });
    if (problems.length === 0 && !isPayable(request.lines, digits)) {
      problems.push("total: above 0 and at most 99 999 units of the currency");
    }
  }
  if (!isTimeZone(request.timeZone)) {
    problems.push("timeZone");
  } else if (!isCalendarDate(request.dueDate)) {
    problems.push("dueDate");
  } else {
    const { first, last } = dueRange(now, request.timeZone);
    if (request.dueDate < first || request.dueDate > last) {
      problems.push(`dueDate: from ${first} to ${last}`);
    }
  }
  if (!isText(request.terms, MAX_INVOICE_TEXT)) problems.push("terms");
  if (!isText(request.legal, MAX_INVOICE_TEXT)) problems.push("legal");
  if (!(request.redirectUrl === null || isRedirectUrl(request.redirectUrl))) {
    problems.push("redirectUrl: an https URL of at most 500 characters");
  }
  if (!Object.hasOwn(INVOICE_WORDS, request.language)) problems.push("language");
  return problems;
}

/**
 * Throws `above_lightning` or `unverified` unless the total, at the point of the present hour, is
 * at most 80 % of the most the Lightning address takes (SPEC.md §13, step 4).
 */
async function requireLightningBounds(
  call: Call,
  channel: Channel,
  totalMinor: number,
  digits: number
): Promise<void> {
  let max: bigint;
  let sats: bigint;
  try {
    const now = call.now();
    const [pay, point] = await Promise.all([
      fetchPayRequest(channel.lightningAddress, call.http),
      new PointBook(channel.currency, call.http).point(pointHour(now), now)
    ]);
    if (point === null) throw new Error("The point of the hour is not published yet");
    max = sendableSats(pay).max;
    sats = satsAt(totalMinor, digits, point);
  } catch {
    throw new AssistantError(
      "unverified",
      "The Lightning address or the price of the hour could not be read: try again in a moment"
    );
  }
  const allowed = (max * (100n - LIGHTNING_MARGIN_PERCENT)) / 100n;
  if (sats > allowed) {
    throw new AssistantError(
      "above_lightning",
      "Without an on-chain address, the invoice must stay below what the Lightning address takes",
      [allowed.toString()]
    );
  }
}

export async function makeInvoice(
  call: Call,
  access: AssistantKey,
  keys: AssistantKeys,
  request: InvoiceRequest
): Promise<MadeInvoice> {
  // 1. The channel, read again: a removal stops this very invoice.
  const channel = await readChannel(call, access, keys);
  const invoicing = invoicingOf(channel);
  const origin = invoicing.linkOrigin;
  if (origin === null) {
    throw new AssistantError("no_web_app", "The merchant's app gives no web app for payment links");
  }
  // 2. Checked whole, before anything is taken.
  const digits = currencyDigits(channel.currency);
  if (digits === null) {
    throw new AssistantError("unsupported_currency", `The account's currency is not supported`);
  }
  const now = call.now();
  const problems = invoiceProblems(request, digits, now);
  if (problems.length > 0) {
    throw new AssistantError("invalid_invoice", "The invoice is not valid", problems);
  }
  const totals = invoiceTotals(request.lines, digits);
  const dueAt = endOfDay(request.dueDate, request.timeZone);
  // 3. A deposit address, when the merchant takes on-chain payments.
  let address: { address: string; tag: string } | null = null;
  if (channel.onchain) {
    const taken = await takeAddress(call, access, keys, channel);
    if (taken.address !== null) address = taken;
  }
  // 4. Without one, Lightning alone pays it, at each hour's point until its due date.
  if (address === null) await requireLightningBounds(call, channel, totals.totalMinor, digits);
  // 5. A number of the merchant's series.
  const number = await takeNumber(
    call,
    keys,
    {
      counterKey: invoicing.counterKey,
      writers: invoicing.counterWriters,
      relays: channel.relays
    },
    dayAt(call.now(), request.timeZone).year
  );
  const numberText = formatInvoiceNumber(number);
  try {
    return await publishInvoice(call, keys, channel, request, {
      origin,
      totals,
      digits,
      dueAt,
      address,
      number,
      numberText
    });
  } catch (error) {
    if (error instanceof AssistantError) throw error;
    throw new AssistantError(
      "network",
      `The invoice could not be published: the number ${numberText} stays unused`
    );
  }
}

/** Steps 6 to 8: the link, its record, the invoice. */
async function publishInvoice(
  call: Call,
  keys: AssistantKeys,
  channel: Channel,
  request: InvoiceRequest,
  made: {
    origin: string;
    totals: InvoiceTotals;
    digits: number;
    dueAt: number;
    address: { address: string; tag: string } | null;
    number: Invoice["number"];
    numberText: string;
  }
): Promise<MadeInvoice> {
  const relays = channel.relays;
  // 6. The sale and its link.
  const saleKey = call.random(32);
  const secret = newLinkSecret(call.random);
  const author = publicKeyOf(secret);
  const sale = linkSale(saleKey, channel, "");
  const startsAt = call.now();
  if (made.dueAt <= startsAt)
    throw new AssistantError("invalid_invoice", "The invoice is not valid", ["dueDate"]);
  const note = `${INVOICE_WORDS[request.language]} ${made.numberText}`;
  if (note.length > MAX_LINK_TEXT)
    throw new AssistantError("invalid_invoice", "The invoice is not valid", ["note"]);
  const node = recordNodeFor(channel.bitcoinNode);
  const payload: LinkPayload = {
    version: LINK_VERSION,
    businessName: channel.businessName,
    lightningAddress: channel.lightningAddress,
    fiat: { minor: made.totals.totalMinor, digits: made.digits, currency: channel.currency },
    note,
    onchainAddress: made.address?.address ?? null,
    startsAt,
    endsAt: made.dueAt,
    ...(request.redirectUrl !== null ? { redirectUrl: request.redirectUrl } : {}),
    registryKey: channel.registryKey,
    registryReader: channel.registryReader,
    owner: channel.linkOwner,
    taker: assistantTakerTag(keys, sale.author),
    ...(node ? { bitcoinNode: node } : {})
  };
  const link = linkEvent(secret, saleKey, payload, call.random);
  // One relay is enough: the payer's page reads every relay of the URL.
  await call.pool.publishToQuorum(relays, link, secret, 1);
  const url = linkUrl(made.origin, author, saleKey, relays);
  // 7. Its record for the merchant's app, on a majority, before the invoice.
  await call.pool.publishToQuorum(
    relays,
    linkRecordEvent(
      keys,
      {
        version: LINK_RECORD_VERSION,
        link: author,
        saleKey: bytesToHex(saleKey),
        createdAt: link.created_at,
        onchainTag: made.address?.tag ?? null,
        relays: [...relays],
        ...sealedLinkSecret(secret, channel, call.random),
        ...(channel.tolerance > 0 ? { tolerance: channel.tolerance } : {})
      },
      call.random
    ),
    keys.member.links.secretKey,
    majority(relays.length)
  );
  // The link's secret is not kept past this call (its writes to the relays past their quorum may
  // still authenticate with it): the merchant's app settles the link with its own key.
  // 8. The invoice.
  const at = Math.max(call.now(), link.created_at);
  const invoice: Invoice = {
    version: INVOICE_VERSION,
    id: bytesToHex(call.random(16)),
    number: made.number,
    status: "sent",
    recipient: request.recipient,
    currency: { code: channel.currency, digits: made.digits },
    lines: request.lines,
    dueDate: request.dueDate,
    dueAt: made.dueAt,
    terms: request.terms,
    legal: request.legal,
    redirectUrl: request.redirectUrl,
    createdAt: at,
    updatedAt: at,
    sent: { at, link: { id: author, key: bytesToHex(saleKey), relays: [...relays], url } }
  };
  await call.pool.publishToQuorum(
    relays,
    invoiceEvent(keys, invoice, call.random),
    keys.invoices.nostr.secretKey,
    1
  );
  return {
    invoice,
    totals: made.totals,
    number: made.numberText,
    url,
    onchainAddress: payload.onchainAddress,
    channel
  };
}
