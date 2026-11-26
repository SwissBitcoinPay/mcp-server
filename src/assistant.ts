import { currencyDigits } from "../vendor/checkout-node/src/currencies.js";
import { nodeWebSocket } from "../vendor/checkout-node/src/websocket.js";

import { invoicingOf, readChannel, type Channel, type Invoicing } from "./protocol/channel.js";
import type { Language } from "./protocol/constants.js";
import { withCall, type Services } from "./protocol/context.js";
import { defaultDueDate, dueRange, dayAt, formatDay } from "./protocol/dates.js";
import { AssistantError } from "./protocol/errors.js";
import { followInvoice, type Followed } from "./protocol/follow/follow.js";
import { formatInvoiceNumber, type Invoice } from "./protocol/invoice.js";
import { parseAssistantKey, type AssistantKey } from "./protocol/key.js";
import { deriveAssistantKeys, type AssistantKeys } from "./protocol/keys.js";
import { makeInvoice, type InvoiceRequest, type MadeInvoice } from "./protocol/make.js";
import { readInvoices, type InvoicesRead } from "./protocol/read.js";
import { madeSince } from "./protocol/same.js";
import { invoicePdf } from "./pdf/invoice-pdf.js";
import { exportTransactions, type ExportRequest, type ExportResult } from "./export/export.js";
import { readExportDecision } from "./export/grant.js";

/*
 * One assistant key's calls (SPEC.md §13 to §15), as the MCP tools make them: each call reads the
 * channel again (a removal stops the very next one) and opens its own connections, released when it
 * is done. Invoices are made one at a time for a key (SPEC.md §17): a number and an address are
 * taken from what the relays hold, which two calls at once would read alike.
 */

/** The services of a real call: the network, the clock, the CSPRNG. */
export function realServices(timeoutMs = 10_000, signal?: AbortSignal): Services {
  return {
    createSocket: (url) => nodeWebSocket(url, timeoutMs),
    fetch: globalThis.fetch.bind(globalThis),
    timeoutMs,
    now: () => Math.floor(Date.now() / 1000),
    ...(signal ? { signal } : {})
  };
}

/** Basis points in percent, as typed: 810 → "8.1", 1000 → "10", 805 → "8.05". */
export function percentText(basisPoints: number): string {
  const fraction = String(basisPoints % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return `${Math.floor(basisPoints / 100)}${fraction === "" ? "" : `.${fraction}`}`;
}

/** The tail of the calls that make invoices, by key: each waits for the one before. */
const queues = new Map<string, Promise<unknown>>();

async function oneAtATime<T>(id: string, run: () => Promise<T>): Promise<T> {
  const before = queues.get(id) ?? Promise.resolve();
  const mine = before.then(run, run);
  const tail = mine.catch(() => undefined);
  queues.set(id, tail);
  try {
    return await mine;
  } finally {
    if (queues.get(id) === tail) queues.delete(id);
  }
}

export type BusinessProfile = {
  name: string;
  businessName: string;
  currency: string;
  currencyDigits: number | null;
  /** The merchant's default VAT rate, in percent (« 8.1 »). */
  defaultVatRate: string;
  onchain: boolean;
  businessAddress: Invoicing["businessAddress"];
  companyNumber: string;
  vatNumber: string;
  /** Whether invoices can be made (the merchant's app gives a web app for payment links). */
  canInvoice: boolean;
  today: string;
  dueDates: { first: string; last: string };
  /** The due date of an invoice the user named none for (DEFAULT_DUE_DAYS after today). */
  defaultDueDate: string;
};

/**
 * What the merchant lets this assistant do (SPEC.md §5, §20), as the relays tell it now: its
 * invoices (its channel's version) and the export of the transactions (the grant's decision).
 */
export type Permissions = { invoicing: boolean; export: boolean };

export class Assistant {
  readonly #access: AssistantKey;
  readonly #keys: AssistantKeys;
  readonly #services: () => Services;
  /** Names this key without holding it: the queue of its invoices. */
  readonly #id: string;

  constructor(keyText: string, services: () => Services = () => realServices()) {
    this.#access = parseAssistantKey(keyText);
    this.#keys = deriveAssistantKeys(this.#access.key);
    this.#services = services;
    this.#id = this.#keys.invoices.nostr.publicKey;
  }

  /** The clock of its calls, Unix seconds. */
  now(): number {
    return this.#services().now();
  }

  /** What the merchant's channel says the invoices print, and the due dates offered today. */
  async profile(timeZone: string): Promise<BusinessProfile> {
    return withCall(this.#services(), async (call) => {
      const channel = await readChannel(call, this.#access, this.#keys);
      const invoicing = invoicingOf(channel);
      const now = call.now();
      return {
        name: channel.name,
        businessName: channel.businessName,
        currency: channel.currency,
        currencyDigits: currencyDigits(channel.currency),
        defaultVatRate: percentText(invoicing.vatRate),
        onchain: channel.onchain,
        businessAddress: invoicing.businessAddress,
        companyNumber: invoicing.companyNumber,
        vatNumber: invoicing.vatNumber,
        canInvoice: invoicing.linkOrigin !== null,
        today: formatDay(dayAt(now, timeZone)),
        dueDates: dueRange(now, timeZone),
        defaultDueDate: defaultDueDate(now, timeZone)
      };
    });
  }

  async make(request: InvoiceRequest): Promise<MadeInvoice> {
    return oneAtATime(this.#id, () =>
      withCall(this.#services(), (call) => makeInvoice(call, this.#access, this.#keys, request))
    );
  }

  /**
   * The invoice like `request` this assistant made at `since` (Unix seconds) or later, or null
   * when a proven read shows none (same.ts: `network`, `newer` otherwise).
   */
  async madeSince(request: InvoiceRequest, since: number): Promise<Invoice | null> {
    return withCall(this.#services(), async (call) => {
      const channel = await readChannel(call, this.#access, this.#keys);
      invoicingOf(channel);
      return madeSince(await readInvoices(call, this.#keys, channel.relays), request, since);
    });
  }

  /**
   * Makes `request` unless an invoice like it was made at `since` or later (same.ts), which it
   * gives instead: the read and the making wait for the key's other invoices, as `make`, so that
   * two calls of the same request make one invoice.
   */
  async makeOnce(
    request: InvoiceRequest,
    since: number
  ): Promise<{ made: MadeInvoice } | { already: Invoice }> {
    return oneAtATime(this.#id, () =>
      withCall(this.#services(), async (call) => {
        const channel = await readChannel(call, this.#access, this.#keys);
        invoicingOf(channel);
        const read = await readInvoices(call, this.#keys, channel.relays);
        const already = madeSince(read, request, since);
        if (already) return { already };
        return { made: await makeInvoice(call, this.#access, this.#keys, request) };
      })
    );
  }

  /**
   * What the merchant lets this assistant do, read on its relays (the channel, then the export's
   * decision there). Throws AssistantError as the channel's read does (`revoked`, `network`…) and
   * as the decision's (`network`, `newer`): never a permission on a guess.
   */
  async permissions(): Promise<Permissions> {
    return withCall(this.#services(), async (call) => {
      const channel = await readChannel(call, this.#access, this.#keys);
      return {
        invoicing: channel.invoicing !== null,
        export: await readExportDecision(call, this.#access, this.#keys, channel.relays)
      };
    });
  }

  async list(): Promise<InvoicesRead> {
    return withCall(this.#services(), async (call) => {
      const channel = await readChannel(call, this.#access, this.#keys);
      invoicingOf(channel);
      return readInvoices(call, this.#keys, channel.relays);
    });
  }

  /**
   * The invoice of `reference` (its number « 2026-0042 », or its id) with its channel; throws
   * `unknown_invoice` when this assistant has none so (or `network` when the read was incomplete).
   */
  async #find(
    call: Parameters<Parameters<typeof withCall>[1]>[0],
    reference: string
  ): Promise<{ invoice: Invoice; channel: Channel & { invoicing: Invoicing } }> {
    const read = await readChannel(call, this.#access, this.#keys);
    const channel = { ...read, invoicing: invoicingOf(read) };
    const found = await readInvoices(call, this.#keys, channel.relays);
    const invoice = found.invoices.find(
      (entry) => entry.id === reference || formatInvoiceNumber(entry.number) === reference
    );
    if (invoice) return { invoice, channel };
    if (!found.complete) {
      throw new AssistantError("network", "Fewer than a majority of the relays answered");
    }
    throw new AssistantError("unknown_invoice", `No invoice ${reference} of this assistant`);
  }

  /** The invoice `reference` names (its number or id), read from the merchant's relays. */
  async invoice(reference: string): Promise<Invoice> {
    const { invoice } = await withCall(this.#services(), (call) => this.#find(call, reference));
    return invoice;
  }

  async follow(reference: string): Promise<{ invoice: Invoice; followed: Followed }> {
    return withCall(this.#services(), async (call) => {
      const { invoice, channel } = await this.#find(call, reference);
      return { invoice, followed: await followInvoice(call, this.#keys, channel, invoice) };
    });
  }

  /** `preferences`: the merchant's preferred languages, most preferred first (pdf/region.ts). */
  async pdf(
    reference: string,
    language: Language,
    timeZone: string,
    preferences: readonly string[] = []
  ): Promise<{ invoice: Invoice; pdf: Buffer }> {
    const { invoice, channel } = await withCall(this.#services(), (call) =>
      this.#find(call, reference)
    );
    const pdf = await invoicePdf(
      invoice,
      { businessName: channel.businessName, invoicing: channel.invoicing },
      { language, timeZone, preferences }
    );
    return { invoice, pdf };
  }

  /** The merchant's transactions of a period, as allowed (SPEC.md §20). */
  async exportTransactions(request: ExportRequest): Promise<ExportResult> {
    return withCall(this.#services(), (call) =>
      exportTransactions(call, this.#access, this.#keys, request)
    );
  }
}
