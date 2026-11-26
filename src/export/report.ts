import { lineDate, rowBy, rowLabel, rowRemark, rowSource } from "./csv.js";
import { btcText, fiatText, formatDate, formatInteger } from "./format.js";
import type { Row, RowValue } from "./lines.js";
import { fill, type ExportTexts } from "./texts.js";

/*
 * What the export's PDF says (SPEC.md §20), as the merchant's app's « Simple (PDF) » says it
 * (src/features/wallet/export/report-html.ts of the app): the business, the title, when it was
 * made, the period, the summary's blocks (the lines counted by source, what came in, what went out
 * and what sending cost, one total per currency), then the list of the lines and a note on the
 * values. The texts and amounts are the app's to the character; pdf.ts lays them out.
 */

export type ReportUnit = "fiat" | "btc";

/** An amount of a currency (minor units), or of bitcoin (sats: currency "BTC"). */
type Money = { minor: bigint; currency: string; digits: number };

/** A line of the summary: its label ("" under the first of a total), its value, lead or sub. */
export type SummaryLine = { kind: "lead" | "sub"; label: string; value: string };

export type Report = {
  /** The language of the texts (the document's). */
  language: string;
  businessName: string;
  title: string;
  made: string;
  period: string;
  /** The summary, block by block. */
  summary: SummaryLine[][];
  linesTitle: string;
  /** The list's header: its columns' names, the amount's last; null for an empty period. */
  header: string[] | null;
  /** Each line's cells, in the header's order; empty for an empty period. */
  rows: string[][];
  /** The list's place when the period has nothing (null otherwise). */
  none: string | null;
  /** The note on the values (a statement in the currency only). */
  notes: string | null;
  /** Whether the list has a remark column (then before the amount). */
  remarks: boolean;
};

const SOURCES = ["pos", "link", "integration", "receive", "send"] as const;

/** Sums of amounts, one per currency. */
class Totals {
  private readonly sums = new Map<string, Money>();

  add(money: Money): void {
    const known = this.sums.get(money.currency);
    this.sums.set(money.currency, known ? { ...known, minor: known.minor + money.minor } : money);
  }

  /** The currency of `none` first, then the others by code, bitcoin last; `none` without any. */
  list(none: Money): Money[] {
    const rank = ({ currency }: Money) =>
      currency === none.currency ? 0 : currency === "BTC" ? 2 : 1;
    const sums = [...this.sums.values()].sort(
      (a, b) => rank(a) - rank(b) || (a.currency < b.currency ? -1 : 1)
    );
    return sums.length > 0 ? sums : [none];
  }
}

export type ReportOptions = {
  businessName: string;
  days: { first: string; last: string };
  unit: ReportUnit;
  currency: string;
  digits: number;
  language: string;
  locale: string;
  timeZone: string;
  texts: ExportTexts;
  madeAt: Date;
};

/** The day `value` (YYYY-MM-DD) written long (« 1 octobre 2026 »), whatever the time zone. */
function longDay(value: string, locale: string): string {
  const [year = 0, month = 1, day = 1] = value.split("-").map(Number);
  return formatDate(new Date(Date.UTC(year, month - 1, day, 12)), locale, "UTC", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

/** The report of `rows` with their `values` (rowValues; null: a statement in bitcoin). */
export function exportReport(
  rows: readonly Row[],
  values: readonly (RowValue | null)[] | null,
  options: ReportOptions
): Report {
  const { businessName, days, unit, currency, digits, language, locale, timeZone, texts } = options;
  const btc = (sats: bigint): Money => ({ minor: sats, currency: "BTC", digits: 8 });
  const valueOf = (index: number): RowValue | null =>
    unit === "fiat" ? (values?.[index] ?? null) : null;
  const amountOf = (index: number): Money => valueOf(index) ?? btc(rows[index]!.sats);
  const feeOf = (index: number): Money => {
    const value = valueOf(index);
    return value && value.feeMinor !== null
      ? { ...value, minor: value.feeMinor }
      : btc(rows[index]!.feeSats ?? 0n);
  };
  const money = ({ minor, currency: code, digits: decimals }: Money, signed: boolean): string =>
    code === "BTC"
      ? btcText(minor, locale, signed)
      : fiatText(minor, decimals, code, locale, signed);
  const zero: Money = unit === "fiat" ? { minor: 0n, currency, digits } : btc(0n);

  const received = new Totals();
  const sent = new Totals();
  const fees = new Totals();
  const counts = new Map<string, number>();
  // A sending whose fees are not told (v2 history): no total of the fees, never « 0 ».
  const feesKnown = rows.every((row) => row.kind !== "sent" || row.feeSats !== null);
  rows.forEach((row, index) => {
    counts.set(row.line.source, (counts.get(row.line.source) ?? 0) + 1);
    if (row.kind === "sent") {
      sent.add(amountOf(index));
      if (row.feeSats !== null) fees.add(feeOf(index));
    } else received.add(amountOf(index));
  });

  const amounts = (
    kind: "lead" | "sub",
    label: string,
    totals: Totals,
    negate: boolean
  ): SummaryLine[] =>
    totals.list(zero).map((total, index) => ({
      kind,
      label: index === 0 ? label : "",
      value: money(negate ? { ...total, minor: -total.minor } : total, true)
    }));
  const summary: SummaryLine[][] = [
    [
      { kind: "lead", label: texts.pdf.count, value: formatInteger(rows.length, locale) },
      ...SOURCES.flatMap((source): SummaryLine[] => {
        const n = counts.get(source) ?? 0;
        return n === 0
          ? []
          : [{ kind: "sub", label: texts.pdf.countOf[source], value: formatInteger(n, locale) }];
      })
    ],
    amounts("lead", texts.pdf.received, received, false),
    ...(counts.has("send")
      ? [
          [
            ...amounts("lead", texts.pdf.sent, sent, false),
            ...(feesKnown ? amounts("sub", texts.pdf.fees, fees, true) : [])
          ]
        ]
      : [])
  ];

  const remarks = rows.some((row) => rowRemark(row, texts, locale, timeZone) !== "");
  const units = new Set(rows.map((_, index) => amountOf(index).currency));
  const unitName = units.size === 0 ? zero.currency : units.size === 1 ? [...units][0]! : null;
  const amountHeader =
    unitName === null ? texts.pdf.amountMixed : fill(texts.pdf.amount, { unit: unitName });
  return {
    language,
    businessName,
    title: texts.pdf.title,
    made: fill(texts.pdf.made, {
      date: formatDate(options.madeAt, locale, timeZone, {
        day: "numeric",
        month: "long",
        year: "numeric"
      })
    }),
    period: fill(texts.pdf.period, {
      first: longDay(days.first, locale),
      last: longDay(days.last, locale)
    }),
    summary,
    linesTitle: texts.pdf.lines,
    header:
      rows.length === 0
        ? null
        : [
            texts.columns.dateAndTime,
            texts.columns.label,
            texts.columns.source,
            texts.columns.by,
            ...(remarks ? [texts.columns.remark] : []),
            amountHeader
          ],
    rows: rows.map((row, index) => [
      lineDate(row.line.at, locale, timeZone),
      rowLabel(row, texts) || "—",
      rowSource(row, texts),
      rowBy(row, texts) || "—",
      ...(remarks ? [rowRemark(row, texts, locale, timeZone)] : []),
      money(amountOf(index), true)
    ]),
    none: rows.length === 0 ? texts.pdf.none : null,
    notes:
      unit === "fiat"
        ? rows.some(({ line }) => line.imported)
          ? texts.pdf.valuesNoteImported
          : texts.pdf.valuesNote
        : null,
    remarks
  };
}
