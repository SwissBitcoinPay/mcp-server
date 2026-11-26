import { readChannel } from "../protocol/channel.js";
import { HISTORY_DAYS, textLanguage } from "../protocol/constants.js";
import type { Call } from "../protocol/context.js";
import { addDays, dayAt, endOfDay, formatDay, parseDay } from "../protocol/dates.js";
import { AssistantError } from "../protocol/errors.js";
import type { AssistantKey } from "../protocol/key.js";
import type { AssistantKeys } from "../protocol/keys.js";
import { PointBook, pointHour } from "../protocol/points.js";

import { DEFAULT_COLUMNS, exportCsv, exportFileName, type ExportColumn } from "./csv.js";
import { currencyDigits, isKnownTimeZone } from "./format.js";
import { readExportGrant } from "./grant.js";
import { exportRows, rowValues, type Line } from "./lines.js";
import { EXPORT_NOTES } from "./notes.js";
import { exportPdf } from "./pdf.js";
import { exportReport, type ReportUnit, type SummaryLine } from "./report.js";
import { readHistoryLines } from "./sources/history.js";
import { integrationSeatsOf, readIntegrationLines } from "./sources/integrations.js";
import { invoiceSourcesOf, linkSeatsOf, readLinkLines } from "./sources/links.js";
import { readSendLines } from "./sources/sends.js";
import { readTillLines, tillSeatsOf, type SetAside } from "./sources/till.js";
import { EXPORT_TEXTS, fill } from "./texts.js";

/*
 * The export of the merchant's transactions of a period (SPEC.md §20), as « Portefeuille ›
 * Exporter » writes it: what the merchant allowed this assistant to read (its grant), every source
 * read on the merchant's relays and each payment checked, then the app's CSV or report. Never a
 * partial statement unsaid: a read without a majority's answer fails the export; a sale whose
 * payment cannot be proven is set aside and told; what the export cannot hold (receptions without
 * a sale, sendings made outside the app) is told with it.
 */

const LANGUAGES = ["fr", "en", "de", "it", "es", "pt", "fi"] as const;
type ExportLanguage = (typeof LANGUAGES)[number];

export type ExportRequest = {
  /** YYYY-MM-DD, the first and last days of the period, both included, in `timeZone`. */
  first: string;
  last: string;
  format: "csv" | "pdf";
  /** The CSV's columns (default: the app's); the PDF has its own. */
  columns?: readonly ExportColumn[];
  /** The PDF's amounts: in the merchant's currency (default) or in bitcoin. */
  unit?: ReportUnit;
  /** The merchant's device's, from the grant, unless the call names others. */
  language?: string;
  locale?: string;
  timeZone?: string;
};

export type ExportResult = {
  fileName: string;
  mimeType: "text/csv" | "application/pdf";
  bytes: Buffer;
  /**
   * What it was written with: the language as a call names it (« de »: its texts are Swiss German
   * when the locale's region is Switzerland's or Liechtenstein's, `textLanguage`).
   */
  language: ExportLanguage;
  locale: string;
  timeZone: string;
  period: { first: string; last: string };
  /** The report's summary (its lines' count by source, the totals). */
  summary: SummaryLine[][];
  lines: number;
  /** Sales whose payment could not be proven: in no line, told here. */
  setAside: SetAside[];
  /** The history copied from the v2 account is not whole on the relays (its copy unfinished). */
  historyIncomplete: boolean;
};

function invalid(detail: string): never {
  throw new AssistantError("invalid_export", "The export is not valid", [detail]);
}

/** Whether `locale` is a BCP 47 tag Intl knows. */
function isLocale(locale: string): boolean {
  try {
    return Intl.getCanonicalLocales(locale).length === 1;
  } catch {
    return false;
  }
}

/** The merchant's transactions of the period, as a CSV or a PDF (SPEC.md §20). */
export async function exportTransactions(
  call: Call,
  access: AssistantKey,
  keys: AssistantKeys,
  request: ExportRequest
): Promise<ExportResult> {
  const channel = await readChannel(call, access, keys);
  const grant = await readExportGrant(call, access, keys, channel.relays);

  // How the merchant's device writes it, unless the call says otherwise.
  const language = (request.language ?? grant.format?.language ?? "fr") as ExportLanguage;
  if (!LANGUAGES.includes(language)) invalid("language");
  const locale = request.locale ?? grant.format?.locale ?? language;
  if (!isLocale(locale)) invalid("locale");
  const timeZone = request.timeZone ?? grant.format?.timeZone ?? "UTC";
  if (!isKnownTimeZone(timeZone)) invalid("timeZone");

  // The period: whole days of its time zone, within the last year, none ahead.
  const first = parseDay(request.first);
  const last = parseDay(request.last);
  if (!first) invalid("first");
  if (!last) invalid("last");
  const days = { first: formatDay(first), last: formatDay(last) };
  if (days.first > days.last) invalid("first: after last");
  const now = call.now();
  const today = dayAt(now, timeZone);
  if (days.last > formatDay(today)) invalid("last: after today");
  if (days.first < formatDay(addDays(today, -(HISTORY_DAYS - 1)))) {
    invalid(`first: more than ${HISTORY_DAYS} days ago (export it from the app)`);
  }
  const range = {
    start: endOfDay(formatDay(addDays(first, -1)), timeZone),
    end: Math.min(endOfDay(days.last, timeZone) - 1, now)
  };

  const auth = keys.member.nostr;
  const { relays } = channel;
  const [sends, history, till, links, integrations] = await Promise.all([
    readSendLines(call, relays, grant.account, auth, range),
    readHistoryLines(call, relays, grant.account.legacyHistory, auth, range),
    readTillLines(call, {
      relays,
      seats: tillSeatsOf(grant.seats),
      auth,
      registryKey: channel.registryKey,
      linkOwner: channel.linkOwner,
      bitcoinNode: channel.bitcoinNode,
      range
    }),
    readLinkLines(call, {
      relays,
      seats: linkSeatsOf(grant.seats),
      invoices: invoiceSourcesOf(grant.account.invoices, grant.seats),
      auth,
      bitcoinNode: channel.bitcoinNode,
      range
    }),
    readIntegrationLines(call, {
      relays,
      seats: integrationSeatsOf(grant.seats),
      auth,
      registryKey: channel.registryKey,
      registryReader: grant.account.registryReader,
      lightningAddress: channel.lightningAddress,
      range
    })
  ]);

  // A sale of a point of sale shared as a link is the link's line (the app's); a sale is one line.
  const linked = (sale: string) => links.sales.has(sale);
  const sales: Line[] = [
    ...till.lines.filter(({ id }) => !linked(id.slice("sale:".length))),
    ...links.lines
  ];
  const ids = new Set(sales.map(({ id }) => id));
  sales.push(...integrations.lines.filter(({ id }) => !ids.has(id)));
  const setAside = [
    ...till.setAside.filter(({ sale }) => !linked(sale)),
    ...links.setAside,
    ...integrations.setAside
  ].sort((a, b) => a.at - b.at || (a.sale < b.sale ? -1 : 1));

  // Each sale with the price of bitcoin of its payment's hour (CoinGecko's, as the app records it).
  const priced = await withRates(call, sales, channel.currency, now);
  const lines = [...sends, ...history.lines, ...priced];

  const rows = exportRows(lines, range);
  const values = rowValues(rows);
  const digits = currencyDigits(channel.currency);
  // German as the locale's region writes it (« de » with « de-CH »: Swiss German), as the app does.
  const written = textLanguage(language, locale);
  const texts = EXPORT_TEXTS[written];
  const notes = EXPORT_NOTES[written];
  const report = exportReport(rows, values, {
    businessName: channel.businessName,
    days,
    unit: request.unit ?? "fiat",
    currency: channel.currency,
    digits,
    language: written,
    locale,
    timeZone,
    texts,
    madeAt: new Date(now * 1000)
  });
  const bytes =
    request.format === "csv"
      ? Buffer.from(
          exportCsv(rows, values, {
            columns: request.columns ?? DEFAULT_COLUMNS,
            currency: channel.currency,
            digits,
            locale,
            timeZone,
            texts
          }),
          "utf8"
        )
      : await exportPdf(report, new Date(now * 1000), [
          notes.excluded,
          ...(setAside.length > 0
            ? [fill(notes.setAside, { count: String(setAside.length) })]
            : []),
          ...(history.incomplete ? [notes.historyIncomplete] : [])
        ]);
  return {
    fileName: exportFileName(channel.businessName, days, request.format),
    mimeType: request.format === "csv" ? "text/csv" : "application/pdf",
    bytes,
    language,
    locale,
    timeZone,
    period: days,
    summary: report.summary,
    lines: rows.length,
    setAside,
    historyIncomplete: history.incomplete
  };
}

/** `sales` each with the point of its payment's hour in `currency`; none when not published. */
async function withRates(
  call: Call,
  sales: readonly Line[],
  currency: string,
  now: number
): Promise<Line[]> {
  if (sales.length === 0 || !/^[A-Z]{3}$/.test(currency) || currency === "BTC") return [...sales];
  const hours = sales.map(({ at }) => pointHour(at));
  const book = new PointBook(currency, call.http);
  let points: ReadonlyMap<number, number>;
  try {
    points = await book.points(Math.min(...hours), Math.max(...hours), now);
  } catch {
    throw new AssistantError("network", "The prices of bitcoin could not be read");
  }
  return sales.map((line) => {
    const rate = points.get(pointHour(line.at));
    return rate === undefined ? line : { ...line, rate: { currency, rate } };
  });
}
