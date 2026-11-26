import { describe, expect, it } from "vitest";

import { AssistantError } from "../src/protocol/errors.js";
import type { Invoice } from "../src/protocol/invoice.js";
import type { InvoiceRequest } from "../src/protocol/make.js";
import type { InvoicesRead } from "../src/protocol/read.js";
import {
  likeInvoice,
  madeSince,
  REPEAT_WINDOW_SECONDS,
  windowStart
} from "../src/protocol/same.js";

import { vectors } from "./helpers/vectors.js";

/*
 * Whether an invoice was already made (src/protocol/same.ts): the recipient's name, the lines and
 * the texts count; the address, the reference and the due date, which the user completes or
 * corrects within one preview, do not.
 */

const invoice = vectors.invoice.value as Invoice;

/** The request that made `invoice`. */
function requestOf(made: Invoice): InvoiceRequest {
  return {
    recipient: { ...made.recipient },
    lines: made.lines.map((line) => ({ ...line })),
    dueDate: made.dueDate,
    terms: made.terms,
    legal: made.legal,
    redirectUrl: made.redirectUrl,
    language: "fr",
    timeZone: "Europe/Zurich"
  };
}

const read = (extra: Partial<InvoicesRead> = {}): InvoicesRead => ({
  invoices: [invoice],
  complete: true,
  newer: false,
  hiddenAt: null,
  ...extra
});

describe("an invoice like a request", () => {
  it("is so whatever its address, reference, due date, language and time zone", () => {
    const request = requestOf(invoice);
    expect(likeInvoice(invoice, request)).toBe(true);
    const completed = structuredClone(request);
    completed.recipient.street = "Autre rue 1";
    completed.recipient.postalCode = "8000";
    completed.recipient.city = "Zürich";
    completed.recipient.country = "DE";
    completed.recipient.reference = "PO-7";
    completed.dueDate = "2027-01-01";
    completed.language = "de";
    completed.timeZone = "Asia/Tokyo";
    expect(likeInvoice(invoice, completed)).toBe(true);
  });

  it("differs by the recipient's name, any line, their order, or a text", () => {
    const request = requestOf(invoice);
    const changes: ((r: InvoiceRequest) => void)[] = [
      (r) => (r.recipient.name += "x"),
      (r) => (r.lines[0]!.name += "x"),
      (r) => (r.lines[0]!.quantity += 1),
      (r) => (r.lines[0]!.unitMinor += 1),
      (r) => (r.lines[0]!.vatRate += 1),
      (r) => r.lines.push({ ...r.lines[0]! }),
      (r) => r.lines.pop(),
      (r) => r.lines.reverse(),
      (r) => (r.terms += "x"),
      (r) => (r.legal += "x"),
      // The text as given (trimmed): a URL written otherwise is another redirect.
      (r) => (r.redirectUrl = `${r.redirectUrl}/`),
      (r) => (r.redirectUrl = null)
    ];
    for (const [index, change] of changes.entries()) {
      const changed = structuredClone(request);
      change(changed);
      expect(JSON.stringify(changed), `change ${index}`).not.toBe(JSON.stringify(request));
      expect(likeInvoice(invoice, changed), `change ${index}`).toBe(false);
    }
  });
});

describe("an invoice made in a request's window", () => {
  const request = requestOf(invoice);
  const at = invoice.sent.at;

  it("starts at the preview, 24 hours ago at the latest", () => {
    const now = 1_800_000_000;
    expect(REPEAT_WINDOW_SECONDS).toBe(86_400);
    expect(windowStart(now, null)).toBe(now - 86_400);
    expect(windowStart(now, now - 60)).toBe(now - 86_400);
    expect(windowStart(now, now - 3 * 86_400)).toBe(now - 3 * 86_400);
  });

  it("is found from the second of its making on, never before", () => {
    expect(madeSince(read(), request, at)).toBe(invoice);
    expect(madeSince(read(), request, at - 3600)).toBe(invoice);
    expect(madeSince(read(), request, at + 1)).toBeNull();
  });

  it("is found on any read that holds it, a partial one too", () => {
    expect(madeSince(read({ complete: false, newer: true, hiddenAt: at }), request, at)).toBe(
      invoice
    );
  });

  it("is never said not made on a read that cannot tell", () => {
    const code = (extra: Partial<InvoicesRead>) => {
      try {
        madeSince(read({ invoices: [], ...extra }), request, at);
        return "none";
      } catch (error) {
        return error instanceof AssistantError ? error.code : "other";
      }
    };
    expect(code({})).toBe("none");
    expect(code({ complete: false })).toBe("network");
    expect(code({ newer: true, hiddenAt: at })).toBe("newer");
    expect(code({ newer: true, hiddenAt: at + 60 })).toBe("newer");
    // A newer app's copy written before the window hides no invoice made in it.
    expect(code({ newer: true, hiddenAt: at - 1 })).toBe("none");
  });
});
