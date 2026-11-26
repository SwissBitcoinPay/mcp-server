import {
  openRecord,
  recordsThatOpen,
  dTagOf
} from "../../vendor/checkout-node/src/nostr/record.js";
import { RECORD_KIND } from "../../vendor/checkout-node/src/protocol.js";

import { INVOICE_TYPE } from "./constants.js";
import type { Call } from "./context.js";
import { parseInvoice, type Invoice } from "./invoice.js";
import { invoiceAddressOf, type AssistantKeys } from "./keys.js";
import { isObject } from "./text.js";

/*
 * The assistant's invoices (SPEC.md §14): its invoices author's records on the merchant's relays,
 * read page by page, the newest valid copy of each id. Fewer than a majority answered: what was
 * read may be incomplete, and is said so, never « no invoice ».
 */

export type InvoicesRead = {
  /** Newest first (by when they were made). */
  invoices: Invoice[];
  /** Whether a majority of the relays answered: otherwise some may be missing. */
  complete: boolean;
  /** A newer app wrote some: they are left out. */
  newer: boolean;
  /**
   * The newest second of a newer app's copy that hid an invoice, or null: an invoice made before
   * it was not hidden by it (same.ts).
   */
  hiddenAt: number | null;
};

export async function readInvoices(
  call: Call,
  keys: AssistantKeys,
  relays: readonly string[]
): Promise<InvoicesRead> {
  return readInvoicesOf(
    call,
    {
      author: keys.invoices.nostr.publicKey,
      encryptionKey: keys.invoices.encryptionKey,
      addressKey: keys.invoices.addressKey
    },
    relays,
    keys.invoices.nostr.secretKey
  );
}

/** What reads an author's invoices: its public key, their NIP-44 key and `d` tags' key. */
export type InvoiceReader = { author: string; encryptionKey: Uint8Array; addressKey: Uint8Array };

/**
 * The invoices of `reader`'s author (the assistant's own, the merchant's, another assistant's: one
 * format, SPEC.md §7), as readInvoices reads them, authenticating with `authKey`.
 */
export async function readInvoicesOf(
  call: Call,
  reader: InvoiceReader,
  relays: readonly string[],
  authKey: Uint8Array
): Promise<InvoicesRead> {
  const { author, encryptionKey: key } = reader;
  const { answers, answered } = await call.pool.queryRelays(
    relays,
    { kinds: [RECORD_KIND], authors: [author] },
    authKey,
    { paged: true, keep: recordsThatOpen((d, by) => (by === author && d !== null ? key : null)) }
  );
  const newest = new Map<string, { invoice: Invoice; createdAt: number; id: string }>();
  const newer = new Map<string, number>();
  const checked = new Set<string>();
  for (const events of answers.values()) {
    for (const value of events) {
      if (isObject(value) && typeof value.id === "string" && checked.has(value.id)) continue;
      const d = dTagOf(value);
      if (d === null) continue;
      const opened = openRecord(value, {
        type: INVOICE_TYPE,
        encryptionKey: key,
        address: d,
        author,
        parse: (v) => {
          const invoice = parseInvoice(v);
          // An invoice is at the address of its own id: a copy elsewhere is not it.
          return invoice && invoiceAddressOf(reader.addressKey, invoice.id) === d ? invoice : null;
        }
      });
      if (!opened) continue;
      checked.add(opened.event.id);
      if (opened.status === "newer") {
        newer.set(d, Math.max(newer.get(d) ?? -1, opened.event.created_at));
        continue;
      }
      const known = newest.get(d);
      const { created_at: createdAt, id } = opened.event;
      if (
        !known ||
        createdAt > known.createdAt ||
        (createdAt === known.createdAt && id < known.id)
      ) {
        newest.set(d, { invoice: opened.value, createdAt, id });
      }
    }
  }
  let hiddenAt: number | null = null;
  for (const [d, at] of newer) {
    const known = newest.get(d);
    if (!known || at > known.createdAt) {
      newest.delete(d);
      hiddenAt = Math.max(hiddenAt ?? at, at);
    }
  }
  return {
    invoices: [...newest.values()]
      .map(({ invoice }) => invoice)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1)),
    complete: answered,
    newer: hiddenAt !== null,
    hiddenAt
  };
}
