import { btcText, decimalSeparator, fiatText, formatDate, plainBtc, plainMinor } from "./format.js";
import type { Row, RowValue } from "./lines.js";
import { fill, type ExportTexts } from "./texts.js";

/*
 * The CSV of the export (SPEC.md §20), byte for byte the merchant's app's « Détaillé (CSV) »
 * (src/features/wallet/export/csv.ts and describe.ts of the app): its columns in their fixed order,
 * its texts, its numbers (plain, never rounded), a byte order mark, CRLF, and a separator that is
 * not the locale's decimal one.
 */

/** Every column, in the order the CSV always writes them. */
export const EXPORT_COLUMNS = [
  "dateAndTime",
  "label",
  "source",
  "by",
  "network",
  "reference",
  "bitcoinAmount",
  "bitcoinFees",
  "fiatAmount",
  "fiatFees",
  "originalAmount",
  "originalCurrency",
  "bitcoinPrice",
  "remark"
] as const;

export type ExportColumn = (typeof EXPORT_COLUMNS)[number];

/** The columns ticked when none are named: the app's defaults. */
export const DEFAULT_COLUMNS: readonly ExportColumn[] = [
  "dateAndTime",
  "label",
  "source",
  "reference",
  "bitcoinAmount",
  "fiatAmount",
  "remark"
];

/** Columns of the merchant's currency: their header names it. */
const FIAT_COLUMNS = new Set<ExportColumn>(["fiatAmount", "fiatFees", "bitcoinPrice"]);

/** Columns of text someone typed or a payment named: written inert for a spreadsheet. */
const TEXT_COLUMNS = new Set<ExportColumn>([
  "label",
  "source",
  "by",
  "network",
  "reference",
  "originalCurrency",
  "remark"
]);

const BOM = "﻿";

/** Whether `columns` need the rows' values in a currency (a rate). */
export function needsValues(columns: readonly ExportColumn[]): boolean {
  return columns.some((column) => FIAT_COLUMNS.has(column));
}

/** A text a spreadsheet would run as a formula, made inert by a leading quote. */
function inert(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function cell(value: string, separator: string): string {
  return value.includes(separator) || /["\r\n]/.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

/** The date and time of a line, as both files write it. */
export function lineDate(at: number, locale: string, timeZone: string): string {
  return formatDate(new Date(at * 1000), locale, timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

/**
 * « Libellé »: an invoice's number and recipient, else the sale's note, else what the wallet tells
 * of a transfer (the Lightning address paid, the description, « Dépôt », « Retrait »).
 */
export function rowLabel(row: Row, texts: ExportTexts): string {
  const { line } = row;
  if (line.invoice) {
    return [line.invoice.number, line.invoice.recipient].filter((part) => part !== "").join(" · ");
  }
  if (line.note) return line.note;
  if (line.source !== "receive" && line.source !== "send") return "";
  const [payment] = line.payments;
  if (!payment) return "";
  if (payment.network === "bitcoin" || payment.network === "unknown") {
    return payment.direction === "receive" ? texts.titles.deposit : texts.titles.withdrawal;
  }
  return payment.lightningAddress ?? payment.description?.trim() ?? "";
}

export function rowSource(row: Row, texts: ExportTexts): string {
  return texts.sources[row.line.source];
}

export function rowBy(row: Row, texts: ExportTexts): string {
  const { by } = row.line;
  if (!by) return "";
  return by.kind === "you" ? texts.you : by.name;
}

function rowNetworks(row: Row, texts: ExportTexts): string {
  const networks = [
    ...new Set(row.line.payments.flatMap(({ network }) => (network === "unknown" ? [] : [network])))
  ];
  return networks.map((network) => texts.networks[network]).join(", ");
}

function rowReferences(row: Row): string {
  return [
    ...new Set(
      row.line.payments.map((payment) => payment.paymentHash ?? payment.txId ?? payment.id)
    )
  ].join(" ");
}

/** The part of `minor` that `received` of `sats` pays, and the rest (the app's splitFiat). */
function restMinor(minor: number, sats: bigint, received: bigint): bigint {
  const whole = BigInt(minor);
  if (sats <= 0n || received <= 0n) return whole;
  const share = received >= sats ? whole : (whole * received) / sats;
  return whole - share;
}

/** « Remarque »: the owner's acceptance of a sale paid short; "" otherwise. */
export function rowRemark(row: Row, texts: ExportTexts, locale: string, timeZone: string): string {
  const acceptance = row.line.acceptance;
  if (!acceptance) return "";
  const due = BigInt(acceptance.due);
  const received = BigInt(row.line.sats);
  const missing = due > received ? due - received : 0n;
  const at = new Date(acceptance.at * 1000);
  const when = {
    date: formatDate(at, locale, timeZone, { day: "2-digit", month: "2-digit", year: "numeric" }),
    time: formatDate(at, locale, timeZone, { hour: "2-digit", minute: "2-digit" }),
    btc: btcText(missing, locale, false)
  };
  const { fiat } = acceptance;
  if (!fiat) return fill(texts.remarks.acceptedSats, when);
  return fill(texts.remarks.accepted, {
    ...when,
    fiat: fiatText(restMinor(fiat.minor, due, received), fiat.digits, fiat.currency, locale, false)
  });
}

export type CsvOptions = {
  columns: readonly ExportColumn[];
  /** The merchant's currency and its decimals. */
  currency: string;
  digits: number;
  /** The merchant's device's locale and time zone. */
  locale: string;
  timeZone: string;
  texts: ExportTexts;
};

/** The CSV of `rows` (the oldest first) with their `values` (rowValues; null: none needed). */
export function exportCsv(
  rows: readonly Row[],
  values: readonly (RowValue | null)[] | null,
  { columns, currency, digits, locale, timeZone, texts }: CsvOptions
): string {
  const shown = EXPORT_COLUMNS.filter((column) => columns.includes(column));
  const decimal = decimalSeparator(locale);
  const separator = decimal === "," ? ";" : ",";
  const header = shown.map((column) =>
    FIAT_COLUMNS.has(column) ? fill(texts.columns[column], { currency }) : texts.columns[column]
  );
  const lines = rows.map((row, index) => {
    // In the merchant's currency only: another's has no place in its columns.
    const found = values?.[index] ?? null;
    const value = found?.currency === currency && found.digits === digits ? found : null;
    const rate = found?.rate?.currency === currency ? found.rate.rate : null;
    const { fiat } = row.line;
    const cells: Record<ExportColumn, () => string> = {
      dateAndTime: () => lineDate(row.line.at, locale, timeZone),
      label: () => rowLabel(row, texts),
      source: () => rowSource(row, texts),
      by: () => rowBy(row, texts),
      network: () => rowNetworks(row, texts),
      reference: () => (row.line.imported ? "" : rowReferences(row)),
      bitcoinAmount: () => plainBtc(row.sats, decimal),
      bitcoinFees: () => (row.feeSats === null ? "" : plainBtc(row.feeSats, decimal)),
      fiatAmount: () => (value === null ? "" : plainMinor(value.minor, value.digits, decimal)),
      fiatFees: () =>
        value === null || value.feeMinor === null
          ? ""
          : plainMinor(value.feeMinor, value.digits, decimal),
      originalAmount: () => (fiat ? plainMinor(BigInt(fiat.minor), fiat.digits, decimal) : ""),
      originalCurrency: () => fiat?.currency ?? "",
      bitcoinPrice: () => (rate === null ? "" : rate.toFixed(digits).replace(".", decimal)),
      remark: () => rowRemark(row, texts, locale, timeZone)
    };
    return shown
      .map((column) => {
        const text = cells[column]();
        return cell(TEXT_COLUMNS.has(column) ? inert(text) : text, separator);
      })
      .join(separator);
  });
  return `${BOM}${[header.map((value) => cell(value, separator)).join(separator), ...lines].join("\r\n")}\r\n`;
}

/** The files' name: the business's, then the period's first and last days (the app's). */
export function exportFileName(
  businessName: string,
  days: { first: string; last: string },
  format: "csv" | "pdf"
): string {
  const name =
    businessName
      .normalize("NFC")
      .replace(/[^\p{L}\p{N}-]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "export";
  return `${name}_${days.first}_${days.last}.${format}`;
}
