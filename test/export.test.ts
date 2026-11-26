import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Assistant } from "../src/assistant.js";
import { pointHour } from "../src/protocol/points.js";

import { grantExport, paidTillSale } from "./helpers/export-world.js";
import { World } from "./helpers/world.js";

/*
 * The export of the transactions (SPEC.md §20), whole: the merchant's grant read with the
 * assistant's key, a sale of the point of sale checked, the price of its hour, and the app's CSV
 * and PDF; nothing without the merchant's grant, nor for a period it cannot tell.
 */

let world: World;

beforeEach(async () => {
  world = await new World().start();
  world.publishChannel(world.channelValue(world.now - 100), world.now - 100);
  world.setPoints("CHF", pointHour(world.now) - 48 * 3600, pointHour(world.now), 80_000);
});

afterEach(async () => {
  await world.stop();
});

const grant = (allowed = true) => grantExport(world, allowed);
const tillSale = () => paidTillSale(world);

const assistant = () => new Assistant(world.keyText, () => world.services());

describe("the export of the transactions", () => {
  it("is the app's CSV of the period, as the merchant's phone writes it", async () => {
    grant();
    tillSale();
    const result = await assistant().exportTransactions({
      first: "2026-11-03",
      last: "2026-11-03",
      format: "csv"
    });
    expect(result).toMatchObject({
      fileName: "Marie-Conseil_2026-11-03_2026-11-03.csv",
      mimeType: "text/csv",
      language: "fr",
      locale: "fr-CH",
      timeZone: "Europe/Zurich",
      lines: 1,
      setAside: [],
      historyIncomplete: false
    });
    const csv = result.bytes.toString("utf8");
    const [header, line] = csv.replace("\ufeff", "").split("\r\n");
    // The app's default columns; 09:00 in Zurich; the sale's own amount.
    expect(header!.split(";")[0]).toBe("Date et heure");
    expect(line).toMatch(/^03\.11\.2026 09:00;Café;Point de Vente;[0-9a-f]{64};0,00015625;12,50;$/);
    // Other columns, as asked: « Par », and the price of its hour.
    const chosen = await assistant().exportTransactions({
      first: "2026-11-03",
      last: "2026-11-03",
      format: "csv",
      columns: ["dateAndTime", "by", "originalCurrency", "bitcoinPrice"]
    });
    expect(chosen.bytes.toString("utf8").split("\r\n")[1]).toBe(
      "03.11.2026 09:00;Vous;CHF;80000,00"
    );
  });

  it("is the app's report as a PDF, with what it does not hold", async () => {
    grant();
    tillSale();
    const result = await assistant().exportTransactions({
      first: "2026-11-01",
      last: "2026-11-03",
      format: "pdf",
      language: "en"
    });
    expect(result.mimeType).toBe("application/pdf");
    expect(result.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(result.summary[0]![0]).toEqual({
      kind: "lead",
      label: "Number of transactions",
      value: "1"
    });
  });

  it("is in German as the locale's region writes it: Swiss German in Switzerland", async () => {
    grant();
    tillSale();
    const received = async (locale: string) =>
      (
        await assistant().exportTransactions({
          first: "2026-11-01",
          last: "2026-11-03",
          format: "pdf",
          language: "de",
          locale
        })
      ).summary
        .flat()
        .find(({ kind, label }) => kind === "lead" && label.endsWith("eingenommen"))?.label;
    expect(await received("de-CH")).toBe("Total eingenommen");
    expect(await received("de-LI")).toBe("Total eingenommen");
    expect(await received("de-DE")).toBe("Insgesamt eingenommen");
  });

  it("is nothing without the merchant's grant", async () => {
    tillSale();
    await expect(
      assistant().exportTransactions({ first: "2026-11-03", last: "2026-11-03", format: "csv" })
    ).rejects.toMatchObject({ code: "export_not_allowed" });
    grant(false);
    await expect(
      assistant().exportTransactions({ first: "2026-11-03", last: "2026-11-03", format: "csv" })
    ).rejects.toMatchObject({ code: "export_not_allowed" });
  });

  it("is refused for a period it cannot tell", async () => {
    grant();
    const ask = (first: string, last: string, extra = {}) =>
      assistant().exportTransactions({ first, last, format: "csv", ...extra });
    await expect(ask("2026-11-04", "2026-11-04")).rejects.toMatchObject({
      code: "invalid_export",
      details: ["last: after today"]
    });
    await expect(ask("2026-11-03", "2026-11-01")).rejects.toMatchObject({ code: "invalid_export" });
    await expect(ask("2025-10-01", "2025-10-31")).rejects.toMatchObject({ code: "invalid_export" });
    await expect(ask("2026-11-31", "2026-11-31")).rejects.toMatchObject({ code: "invalid_export" });
    await expect(
      ask("2026-11-01", "2026-11-03", { timeZone: "Mars/Olympus" })
    ).rejects.toMatchObject({ code: "invalid_export", details: ["timeZone"] });
  });
});
