import { AssistantError } from "./errors.js";
import type { Invoice } from "./invoice.js";
import type { InvoiceRequest } from "./make.js";
import type { InvoicesRead } from "./read.js";

/*
 * Whether an invoice was already made (SPEC.md §16, « Made once »). An AI app may ask for the same
 * invoice twice: its invoice card stays live in the conversation and is shown again when the
 * conversation is opened again, its button with it; the model may be told « make it » once the
 * card made it, and preview it anew first; a host may time out on a call that made it.
 *
 * So an invoice is made only when no invoice like it was made in the window of the request: since
 * its preview (previewedAt), and at least the last 24 hours. An invoice like it is one to the same
 * recipient's name, with the same lines in the same order and the same texts (conditions, legal
 * notice, redirect URL): within one preview, the address, the reference and the due date are what
 * the user completes or corrects, in the card or in the conversation, and an invoice that differs
 * there only is the same invoice made again. Another one like it is made only when the user asks
 * for it once told of the first (create_invoice's `repeat`).
 */

/** The last seconds in which an invoice like a request's is given back instead of made again. */
export const REPEAT_WINDOW_SECONDS = 24 * 3600;

/** Where the window of a request starts: its preview, and 24 hours ago at the latest. */
export function windowStart(now: number, previewedAt: number | null): number {
  return Math.min(previewedAt ?? now, now - REPEAT_WINDOW_SECONDS);
}

/** Whether `invoice` is like `request`: its recipient's name, its lines, its texts. */
export function likeInvoice(invoice: Invoice, request: InvoiceRequest): boolean {
  return (
    invoice.recipient.name === request.recipient.name &&
    invoice.lines.length === request.lines.length &&
    invoice.lines.every((line, index) => {
      const other = request.lines[index];
      return (
        other !== undefined &&
        line.name === other.name &&
        line.quantity === other.quantity &&
        line.unitMinor === other.unitMinor &&
        line.vatRate === other.vatRate
      );
    }) &&
    invoice.terms === request.terms &&
    invoice.legal === request.legal &&
    invoice.redirectUrl === request.redirectUrl
  );
}

/**
 * The newest invoice of `read` made at `since` (Unix seconds) or later like `request`, or null
 * when none was. Only a read that proves it tells « none »: fewer than a majority of the relays
 * answered (`network`), or a newer app's copy written since then hid an invoice (`newer`), and it
 * cannot be told.
 */
export function madeSince(
  read: InvoicesRead,
  request: InvoiceRequest,
  since: number
): Invoice | null {
  const found = read.invoices.find(
    (invoice) => invoice.sent.at >= since && likeInvoice(invoice, request)
  );
  if (found) return found;
  if (!read.complete) {
    throw new AssistantError(
      "network",
      "Fewer than a majority of the relays answered: whether this invoice was already made cannot be told"
    );
  }
  // A copy is written after its invoice was made: one written before `since` hides none since.
  if (read.hiddenAt !== null && read.hiddenAt >= since) {
    throw new AssistantError(
      "newer",
      "A newer app wrote some invoices: whether this invoice was already made cannot be told"
    );
  }
  return null;
}
