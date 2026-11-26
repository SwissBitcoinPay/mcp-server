import { describe, expect, it } from "vitest";

import type { Invoicing } from "../src/protocol/channel.js";
import type { Invoice } from "../src/protocol/invoice.js";
import { countryName, money, numericDate, quantityText, vatLabel } from "../src/pdf/format.js";
import { businessNumbers, invoiceFileName, invoicePdf } from "../src/pdf/invoice-pdf.js";
import { PDF_LABELS } from "../src/pdf/labels.js";

import { vectors } from "./helpers/vectors.js";

const invoice = vectors.invoice.value as Invoice;
const invoicing = vectors.channel.value.invoicing as unknown as Invoicing;

describe("an invoice's PDF", () => {
  it("is a PDF of the invoice, in every language of the app", async () => {
    for (const language of ["fr", "en", "de", "it", "es", "pt", "fi"] as const) {
      const pdf = await invoicePdf(
        invoice,
        { businessName: "Carol Consulting", invoicing },
        { language, timeZone: "Europe/Zurich" }
      );
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(pdf.subarray(-6).toString("latin1")).toContain("%%EOF");
      expect(pdf.length).toBeGreaterThan(10_000);
    }
  });

  it("is named as the app names it", () => {
    expect(invoiceFileName(invoice, "fr")).toBe("Facture-2026-0042.pdf");
    expect(invoiceFileName(invoice, "de")).toBe("Rechnung-2026-0042.pdf");
  });

  it("writes amounts from their integers, with the locale's separators", () => {
    // Separators are the runtime's locale data: locales whose data is stable across versions.
    expect(money(400432, 2, "en-US")).toBe("4,004.32");
    expect(money(400432, 2, "de-DE")).toBe("4.004,32");
    expect(money(5, 2, "fr-FR")).toBe("0,05");
    expect(money(1200, 0, "fr-FR")).toBe("1 200");
    expect(quantityText(150, "fr-CH")).toBe("1,5");
    expect(quantityText(2400, "fr-CH")).toBe("24");
    expect(vatLabel(810, "de-CH")).toBe("8.1%");
    expect(numericDate("2026-12-03", "fr-CH")).toBe("03.12.2026");
    expect(countryName("CH", "fr")).toBe("Suisse");
    expect(countryName("CH", "de")).toBe("Schweiz");
  });

  it("names the business's numbers as its country does, the Swiss IDE once", () => {
    const fr = PDF_LABELS.fr;
    expect(businessNumbers(invoicing, fr)).toEqual([
      { label: "Numéro TVA", value: "CHE-123.456.789 MWST" }
    ]);
    const french: Invoicing = {
      ...invoicing,
      businessAddress: { street: "Rue", postalCode: "75001", city: "Paris", country: "FR" },
      companyNumber: "123 456 789 00012",
      vatNumber: "FR12345678901"
    };
    expect(businessNumbers(french, fr)).toEqual([
      { label: "Numéro SIRET", value: "123 456 789 00012" },
      { label: "Numéro de TVA intracommunautaire", value: "FR12345678901" }
    ]);
    expect(businessNumbers({ ...french, companyNumber: "", vatNumber: "" }, fr)).toEqual([]);
  });
});
