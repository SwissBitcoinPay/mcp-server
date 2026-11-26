import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { exportCsv, exportFileName, type ExportColumn } from "../src/export/csv.js";
import { currencyDigits, formatDate } from "../src/export/format.js";
import { exportRows, rowValues, type Line } from "../src/export/lines.js";
import { exportReport, type Report, type ReportUnit } from "../src/export/report.js";
import { EXPORT_TEXTS } from "../src/export/texts.js";
import type { TextLanguage } from "../src/protocol/constants.js";

/*
 * The export's files as the merchant's app writes them (SPEC.md §20): every case of the app's
 * vectors (vectors/app/export.json, made by its src/__tests__/export-vectors.test.ts), the CSV
 * byte for byte, the report's every text as the app's HTML holds it.
 */

type VectorCase = {
  name: string;
  options: {
    language: TextLanguage;
    locale: string;
    timeZone: string;
    businessName: string;
    currency: string;
    columns: ExportColumn[];
    unit: ReportUnit;
    days: { first: string; last: string };
    range: { start: number; end: number };
    madeAt: number;
  };
  lines: string[];
  csv: string;
  html: string;
  fileNames: { csv: string; pdf: string };
};

const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "vectors", "app", "export.json"), "utf8")
) as { lines: Line[]; cases: VectorCase[] };

const unescape = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");

const all = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((m) => m);
const one = (text: string, pattern: RegExp) => {
  const found = pattern.exec(text);
  return found ? unescape(found[1]!) : null;
};

/** What the app's HTML says, in the shape of the server's report. */
function reportOf(html: string): Omit<Report, "remarks"> {
  const list = /<table class="list">([\s\S]*?)<\/table>/.exec(html)?.[1] ?? null;
  const header = list
    ? all(/<thead>([\s\S]*?)<\/thead>/.exec(list)![1]!, /<th(?: class="num")?>(.*?)<\/th>/g).map(
        (m) => unescape(m[1]!)
      )
    : null;
  const body = list ? /<tbody>\n([\s\S]*?)\n {2}<\/tbody>/.exec(list)![1]! : "";
  return {
    language: one(html, /<html lang="(.*?)">/)!,
    businessName: one(html, /<div class="business">(.*?)<\/div>/)!,
    title: one(html, /<h1>(.*?)<\/h1>/)!,
    made: one(html, /<p class="made">(.*?)<\/p>/)!,
    period: one(html, /<div class="band">(.*?)<\/div>/)!,
    summary: all(html, /<tbody class="block">\n([\s\S]*?)\n<\/tbody>/g).map((block) =>
      all(
        block[1]!,
        /<tr class="(lead|sub)"><td>(.*?)<\/td><td class="num">(.*?)<\/td><\/tr>/g
      ).map((m) => ({
        kind: m[1] as "lead" | "sub",
        label: unescape(m[2]!),
        value: unescape(m[3]!)
      }))
    ),
    linesTitle: one(html, /<h2>(.*?)<\/h2>/)!,
    header,
    rows: all(body, /<tr>\n([\s\S]*?)\n<\/tr>/g).map((row) =>
      all(row[1]!, /<td(?: class="[a-z]+")?>(.*?)<\/td>/g).map((m) => unescape(m[1]!))
    ),
    none: one(html, /<p class="empty">(.*?)<\/p>/),
    notes: one(html, /<p class="notes">(.*?)<\/p>/)
  };
}

/**
 * The ICU the vectors were made with (Node 22.23.5's, the app's): the texts are compared exactly
 * there. Another ICU may group thousands with another character (fr-CH: U+202F in 78.2, the hosted
 * server's Node 22.22.2, an apostrophe in 78.3), as two phones of the merchant may: elsewhere the
 * group separators are compared as one, everything else exactly.
 */
const VECTORS_ICU = "78.3";
const exact = process.versions.icu === VECTORS_ICU;
const GROUPS = /(?<=\d)[\u202f\u00a0'\u2019.\s](?=\d{3}(?!\d))/g;
const grouped = <T>(value: T): T =>
  exact ? value : (JSON.parse(JSON.stringify(value).replace(GROUPS, "\u2009")) as T);

describe("the export's files, as the app's vectors (vectors/app/export.json)", () => {
  it("hold every case the app made", () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(9);
  });

  for (const vector of vectors.cases) {
    describe(vector.name, () => {
      const { options } = vector;
      const lines = vectors.lines.filter(({ id }) => vector.lines.includes(id));
      const rows = exportRows(lines, options.range);
      const values = rowValues(rows);
      const texts = EXPORT_TEXTS[options.language];
      const digits = currencyDigits(options.currency);

      it("writes the CSV byte for byte", () => {
        expect(
          exportCsv(rows, values, {
            columns: options.columns,
            currency: options.currency,
            digits,
            locale: options.locale,
            timeZone: options.timeZone,
            texts
          })
        ).toBe(vector.csv);
      });

      it("says in its report what the app's says", () => {
        const { remarks, ...report } = exportReport(rows, values, {
          businessName: options.businessName,
          days: options.days,
          unit: options.unit,
          currency: options.currency,
          digits,
          language: options.language,
          locale: options.locale,
          timeZone: options.timeZone,
          texts,
          madeAt: new Date(options.madeAt * 1000)
        });
        expect(grouped(report)).toEqual(grouped(reportOf(vector.html)));
        expect(remarks).toBe(vector.html.includes('<td class="remark">'));
      });

      it("names its files as the app does", () => {
        expect(exportFileName(options.businessName, options.days, "csv")).toBe(
          vector.fileNames.csv
        );
        expect(exportFileName(options.businessName, options.days, "pdf")).toBe(
          vector.fileNames.pdf
        );
      });
    });
  }
});

describe("dates in the merchant's time zone", () => {
  it("writes a line's date and time in the time zone it is given, not the server's", () => {
    // 26.10.2026 09:46 UTC: 10:46 in Zurich, 05:46 in New York.
    const at = new Date(1_793_008_000 * 1000);
    const options = {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    } as const;
    expect(formatDate(at, "fr-CH", "Europe/Zurich", options)).toBe("26.10.2026 10:46");
    expect(formatDate(at, "en-US", "America/New_York", options)).toBe("10/26/2026, 05:46 AM");
    expect(formatDate(at, "fr-CH", "UTC", options)).toBe("26.10.2026 09:46");
  });
});
