import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import PDFDocument from "pdfkit";
import createQrCode from "qrcode-generator";

import { invoiceTotals, lineNetMinor } from "../protocol/amounts.js";
import type { Invoicing } from "../protocol/channel.js";
import { textLanguage, type Language } from "../protocol/constants.js";
import { formatInvoiceNumber, type Invoice } from "../protocol/invoice.js";

import {
  countryName,
  money,
  moneyWithCurrency,
  numericDate,
  quantityText,
  vatLabel
} from "./format.js";
import { PDF_LABELS, type PdfLabels } from "./labels.js";
import { merchantRegion } from "./region.js";

/*
 * An invoice's PDF, laid out as the merchant's app lays it out (src/features/invoices/
 * invoice-html.ts): the business, its address and its numbers, the recipient under « Facturé à »,
 * « Facture » and its number, the dates, the lines, the totals rate by rate, the notices under
 * their titles, then « Payer en bitcoin » with the Bitcoin logo, the payment link's QR code at
 * 50 mm beside the link. Pure black text, stone labels, a sand box for the payment; Plus Jakarta
 * Sans 500, 700 and 800 with tabular figures; A4 with the app's margins. Drawn with pdfkit rather
 * than printed from HTML: the same content and measures, the layout done by hand (no browser on
 * the merchant's computer nor on the hosted server).
 */

const MM = 72 / 25.4;
const PAGE = { width: 210 * MM, height: 297 * MM };
const MARGINS = { top: 16 * MM, right: 18 * MM, bottom: 15 * MM, left: 18 * MM };
const CONTENT = PAGE.width - MARGINS.left - MARGINS.right;
const INK = "#000000";
const STONE = "#6E675E";
const SAND = "#F2ECE0";
/** rgba(0, 0, 0, 0.14) on white. */
const HAIRLINE = "#DBDBDB";
const QR_SIZE = 50 * MM;

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The folder of the font files (assets/fonts, at the package's root): two folders up from
 * src/pdf/ (tests), three from dist/src/pdf/ (the build, the bundle).
 */
function fontsDir(): string {
  for (const dir of [
    join(HERE, "..", "..", "assets", "fonts"),
    join(HERE, "..", "..", "..", "assets", "fonts")
  ]) {
    if (existsSync(join(dir, "PlusJakartaSans-Medium.ttf"))) return dir;
  }
  throw new Error("The invoice's fonts are missing");
}

let fonts: { medium: Buffer; bold: Buffer; extraBold: Buffer } | null = null;

export function loadFonts() {
  if (!fonts) {
    const dir = fontsDir();
    fonts = {
      medium: readFileSync(join(dir, "PlusJakartaSans-Medium.ttf")),
      bold: readFileSync(join(dir, "PlusJakartaSans-Bold.ttf")),
      extraBold: readFileSync(join(dir, "PlusJakartaSans-ExtraBold.ttf"))
    };
  }
  return fonts;
}

type Weight = "medium" | "bold" | "extraBold";

/** What the issuer prints: its name, and the channel's `invoicing` (address, numbers). */
export type Issuer = { businessName: string; invoicing: Invoicing };

/** The Bitcoin logo (Wikimedia Commons, File:Bitcoin.svg, public domain), as the app draws it. */
const BTC_CIRCLE =
  "m63.033,39.744c-4.274,17.143-21.637,27.576-38.782,23.301-17.138-4.274-27.571-21.638-23.295-38.78,4.272-17.145,21.635-27.579,38.775-23.305,17.144,4.274,27.576,21.64,23.302,38.784z";
const BTC_B =
  "m46.103,27.444c0.637-4.258-2.605-6.547-7.038-8.074l1.438-5.768-3.511-0.875-1.4,5.616c-0.923-0.23-1.871-0.447-2.813-0.662l1.41-5.653-3.509-0.875-1.439,5.766c-0.764-0.174-1.514-0.346-2.242-0.527l0.004-0.018-4.842-1.209-0.934,3.75s2.605,0.597,2.55,0.634c1.422,0.355,1.679,1.296,1.636,2.042l-1.638,6.571c0.098,0.025,0.225,0.061,0.365,0.117-0.117-0.029-0.242-0.061-0.371-0.092l-2.296,9.205c-0.174,0.432-0.615,1.08-1.609,0.834,0.035,0.051-2.552-0.637-2.552-0.637l-1.743,4.019,4.569,1.139c0.85,0.213,1.683,0.436,2.503,0.646l-1.453,5.834,3.507,0.875,1.439-5.772c0.958,0.26,1.888,0.5,2.798,0.726l-1.434,5.745,3.511,0.875,1.453-5.823c5.987,1.133,10.489,0.676,12.384-4.739,1.527-4.36-0.076-6.875-3.226-8.515,2.294-0.529,4.022-2.038,4.483-5.155zm-8.022,11.249c-1.085,4.36-8.426,2.003-10.806,1.412l1.928-7.729c2.38,0.594,10.012,1.77,8.878,6.317zm1.086-11.312c-0.99,3.966-7.1,1.951-9.082,1.457l1.748-7.01c1.982,0.494,8.365,1.416,7.334,5.553z";

/** The European Union's member states: their VAT numbers are intra-EU. */
const EU_MEMBERS = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU",
  "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"
]); // prettier-ignore
const NAMED_COMPANY_NUMBERS = ["CH", "FR", "DE", "IT", "ES", "PT", "FI"] as const;

function compact(number: string): string {
  return number.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/** The business's numbers, each named by its country (business-details.ts of the app). */
export function businessNumbers(
  invoicing: Invoicing,
  labels: PdfLabels
): { label: string; value: string }[] {
  const country = invoicing.businessAddress?.country ?? invoicing.detectedCountry;
  const { companyNumber, vatNumber } = invoicing;
  const named = NAMED_COMPANY_NUMBERS.find((code) => code === country);
  const companyLabel = labels.company[named ?? "other"];
  const vatLabelText =
    country === "CH"
      ? labels.vatNumber.CH
      : country !== null && EU_MEMBERS.has(country)
        ? labels.vatNumber.EU
        : labels.vatNumber.other;
  const repeated =
    country === "CH" &&
    companyNumber !== "" &&
    vatNumber !== "" &&
    compact(vatNumber).includes(compact(companyNumber));
  return [
    { label: companyLabel, value: repeated ? "" : companyNumber },
    { label: vatLabelText, value: vatNumber }
  ].filter(({ value }) => value !== "");
}

/** The business's address lines: none while neither street, postal code nor city is typed. */
function addressLines(invoicing: Invoicing, language: Language): string[] {
  const address = invoicing.businessAddress;
  if (!address) return [];
  const { street, postalCode, city, country } = address;
  if (street === "" && postalCode === "" && city === "") return [];
  return [
    street,
    [postalCode, city].filter(Boolean).join(" "),
    country ? countryName(country, language) : ""
  ].filter((line) => line !== "");
}

/** The narrow no-break space is not in Plus Jakarta Sans: a no-break space stands for it. */
export function clean(text: string): string {
  return text.replace(/\u202f/g, "\u00a0");
}

/** « Facture-2026-0042.pdf ». */
export function invoiceFileName(invoice: Invoice, language: Language): string {
  const title = PDF_LABELS[language].title.replace(
    "{{number}}",
    formatInvoiceNumber(invoice.number)
  );
  return `${title.replace(/[^\p{L}\p{N}-]+/gu, "-").replace(/^-+|-+$/g, "")}.pdf`;
}

/**
 * An invoice's locale, the invoice's language in the merchant's region (« de-CH », region.ts), and
 * its words: German as that region writes it, Swiss German in Switzerland or Liechtenstein.
 */
export function invoiceWords(
  language: Language,
  preferences: readonly string[],
  invoicing: Pick<Invoicing, "detectedCountry" | "businessAddress">
): { tag: string; labels: PdfLabels } {
  const region = merchantRegion(language, preferences, invoicing);
  const tag = region ? `${language}-${region}` : language;
  return { tag, labels: PDF_LABELS[textLanguage(language, tag)] };
}

/**
 * The PDF of a sent invoice, in `language`, its dates as of `timeZone`, its numbers and words as
 * the merchant's region writes them: `preferences`, the merchant's preferred languages, most
 * preferred first (region.ts).
 */
export async function invoicePdf(
  invoice: Invoice,
  issuer: Issuer,
  {
    language,
    timeZone,
    preferences = []
  }: { language: Language; timeZone: string; preferences?: readonly string[] }
): Promise<Buffer> {
  const { tag, labels } = invoiceWords(language, preferences, issuer.invoicing);
  const number = formatInvoiceNumber(invoice.number);
  const { digits } = invoice.currency;
  const totals = invoiceTotals(invoice.lines, digits);
  const loaded = loadFonts();
  const doc = new PDFDocument({
    size: [PAGE.width, PAGE.height],
    margins: MARGINS,
    autoFirstPage: true,
    info: {
      Title: labels.title.replace("{{number}}", number),
      Author: issuer.businessName,
      Creator: "sattle.me",
      CreationDate: new Date(invoice.sent.at * 1000)
    }
  });
  doc.registerFont("medium", loaded.medium);
  doc.registerFont("bold", loaded.bold);
  doc.registerFont("extraBold", loaded.extraBold);
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  /** Sets the font; returns pdfkit's options for a CSS line-height of `ratio`. */
  const font = (weight: Weight, size: number, ratio = 1.45) => {
    doc.font(weight).fontSize(size);
    const gap = Math.max(0, size * ratio - doc.currentLineHeight(false));
    return { lineGap: gap, features: ["tnum"] as PDFKit.Mixins.OpenTypeFeatures[] };
  };
  /** The width of `text` on one line, as `write` draws it (tabular figures, spacing). */
  const textWidth = (text: string, weight: Weight, size: number, spacing = 0) => {
    const { features } = font(weight, size);
    return doc.widthOfString(clean(text), { features, characterSpacing: spacing });
  };
  const measure = (
    text: string,
    weight: Weight,
    size: number,
    width: number,
    extra: object = {}
  ) => {
    const options = { ...font(weight, size), width, ...extra };
    return doc.heightOfString(clean(text), options);
  };
  const write = (
    text: string,
    x: number,
    y: number,
    {
      weight = "medium",
      size = 9.5,
      width,
      color = INK,
      align = "left",
      ratio = 1.45,
      spacing = 0,
      link
    }: {
      weight?: Weight;
      size?: number;
      width: number;
      color?: string;
      align?: "left" | "right";
      ratio?: number;
      spacing?: number;
      link?: string;
    }
  ): number => {
    const options = {
      ...font(weight, size, ratio),
      width,
      align,
      characterSpacing: spacing,
      lineBreak: true,
      ...(link ? { link } : {})
    };
    doc.fillColor(color).text(clean(text), x, y, options);
    return doc.heightOfString(clean(text), options);
  };
  /** A label in small capitals: 7.5 pt, bold, stone, spaced. */
  const label = (
    text: string,
    x: number,
    y: number,
    width: number,
    align: "left" | "right" = "left"
  ) =>
    write(text.toLocaleUpperCase(language), x, y, {
      weight: "bold",
      size: 7.5,
      width,
      color: STONE,
      spacing: 0.6,
      align
    });
  const bottom = PAGE.height - MARGINS.bottom;
  let y = MARGINS.top;
  /** Starts a new page unless `height` fits below `y`. */
  const room = (height: number) => {
    if (y + height > bottom) {
      doc.addPage();
      y = MARGINS.top;
    }
  };

  // The business and its numbers, the recipient on the right.
  const left = MARGINS.left;
  const senderWidth = 98 * MM - 6 * MM;
  let senderY = y;
  senderY += write(issuer.businessName, left, senderY, {
    weight: "extraBold",
    size: 13,
    width: senderWidth,
    ratio: 1.2
  });
  const from = addressLines(issuer.invoicing, language);
  if (from.length > 0) {
    senderY += 1.5 * MM;
    senderY += write(from.join("\n"), left, senderY, { size: 9, width: senderWidth });
  }
  const numbers = businessNumbers(issuer.invoicing, labels);
  if (numbers.length > 0) {
    senderY += 3 * MM;
    let x = left;
    let rowHeight = 0;
    for (const { label: name, value } of numbers) {
      const width = Math.min(
        senderWidth,
        Math.max(
          textWidth(value, "medium", 9),
          textWidth(name.toLocaleUpperCase(language), "bold", 7.5, 0.6)
        ) + 2
      );
      if (x > left && x + width > left + senderWidth) {
        x = left;
        senderY += rowHeight + 2 * MM;
        rowHeight = 0;
      }
      let h = label(name, x, senderY, width);
      h += 0.5 * MM;
      h += write(value, x, senderY + h, { size: 9, width });
      rowHeight = Math.max(rowHeight, h);
      x += width + 6 * MM;
    }
    senderY += rowHeight;
  }
  const recipientX = left + 98 * MM;
  const recipientWidth = CONTENT - 98 * MM;
  let recipientY = y + 16.5 * MM;
  recipientY += label(labels.billedTo, recipientX, recipientY, recipientWidth) + 1.5 * MM;
  const { recipient } = invoice;
  recipientY += write(recipient.name, recipientX, recipientY, {
    weight: "bold",
    size: 10,
    width: recipientWidth,
    ratio: 1.5
  });
  recipientY += write(
    [
      recipient.street,
      [recipient.postalCode, recipient.city].filter(Boolean).join(" "),
      countryName(recipient.country, language)
    ].join("\n"),
    recipientX,
    recipientY,
    { size: 10, width: recipientWidth, ratio: 1.5 }
  );
  y = Math.max(senderY, Math.max(recipientY, y + 16.5 * MM + 24 * MM));

  // « Facture » and its number.
  y += 8 * MM;
  font("extraBold", 26);
  doc.fillColor(INK).text(labels.invoice, left, y, {
    continued: true,
    lineBreak: false,
    ...font("extraBold", 26, 1.1)
  });
  doc.font("medium").fillColor(STONE).text(` ${number}`, { lineBreak: false });
  y += 26 * 1.1;

  // The dates, and the client's reference.
  y += 7 * MM;
  const issued = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(invoice.sent.at * 1000));
  const facts = [
    { name: labels.date, value: numericDate(issued, tag) },
    { name: labels.due, value: numericDate(invoice.dueDate, tag) },
    ...(recipient.reference ? [{ name: labels.reference, value: recipient.reference }] : [])
  ];
  const factWidth = CONTENT / facts.length;
  let factsHeight = 0;
  facts.forEach(({ name, value }, index) => {
    const x = left + index * factWidth;
    let h = label(name, x, y, factWidth - 4 * MM) + 1.5 * MM;
    h += write(value, x, y + h, { weight: "bold", size: 10.5, width: factWidth - 4 * MM });
    factsHeight = Math.max(factsHeight, h);
  });
  y += factsHeight;

  // The lines: numbers on the right, as wide as they need, the designation in the rest.
  y += 8 * MM;
  const headers = [
    labels.quantityShort,
    labels.unitPriceShort,
    labels.vat,
    `${labels.amount} ${invoice.currency.code}`
  ];
  const rows = invoice.lines.map((line) => ({
    name: line.name,
    cells: [
      quantityText(line.quantity, tag),
      money(line.unitMinor, digits, tag),
      vatLabel(line.vatRate, tag),
      money(Number(lineNetMinor(line)), digits, tag)
    ]
  }));
  const columnWidths = headers.map((header, index) => {
    let width = textWidth(header.toLocaleUpperCase(language), "bold", 7.5, 0.6);
    for (const row of rows) width = Math.max(width, textWidth(row.cells[index]!, "medium", 9.5));
    return width + 2 + 5 * MM;
  });
  const nameWidth = CONTENT - columnWidths.reduce((sum, width) => sum + width, 0);
  const header = () => {
    let x = left;
    let h = label(labels.name, x, y, nameWidth);
    x += nameWidth;
    headers.forEach((text, index) => {
      h = Math.max(h, label(text, x, y, columnWidths[index]!, "right"));
      x += columnWidths[index]!;
    });
    y += h + 2.5 * MM;
    doc
      .moveTo(left, y)
      .lineTo(left + CONTENT, y)
      .lineWidth(0.3 * MM)
      .strokeColor(INK)
      .stroke();
  };
  room(30 * MM);
  header();
  for (const row of rows) {
    const height =
      Math.max(
        measure(row.name, "medium", 9.5, nameWidth - 2 * MM),
        ...row.cells.map((cell) => measure(cell, "medium", 9.5, 1000))
      ) +
      5.2 * MM;
    if (y + height > bottom) {
      doc.addPage();
      y = MARGINS.top;
      header();
    }
    write(row.name, left, y + 2.6 * MM, { width: nameWidth - 2 * MM });
    let x = left + nameWidth;
    row.cells.forEach((cell, index) => {
      write(cell, x, y + 2.6 * MM, { width: columnWidths[index]!, align: "right" });
      x += columnWidths[index]!;
    });
    y += height;
    doc
      .moveTo(left, y)
      .lineTo(left + CONTENT, y)
      .lineWidth(0.2 * MM)
      .strokeColor(HAIRLINE)
      .stroke();
  }

  // The totals, rate by rate, on the right.
  const sums = [
    { name: labels.net, value: money(totals.netMinor, digits, tag) },
    ...totals.vat.map((group) => ({
      name: labels.vatOn
        .replace("{{rate}}", vatLabel(group.rate, tag))
        .replace("{{base}}", money(group.baseMinor, digits, tag)),
      value: money(group.vatMinor, digits, tag)
    }))
  ];
  const totalText = moneyWithCurrency(totals.totalMinor, invoice.currency, tag);
  const sumWidth = 88 * MM;
  const sumX = left + CONTENT - sumWidth;
  const sumHeight = sums.length * (9.5 * 1.45 + 2.4 * MM) + 3 * MM + 14 * 1.45 + 6 * MM;
  y += 4 * MM;
  room(sumHeight);
  for (const { name, value } of sums) {
    y += 1.2 * MM;
    const valueWidth = textWidth(value, "medium", 9.5) + 2;
    write(name, sumX, y, { width: sumWidth - valueWidth - 5 * MM });
    write(value, sumX, y, { width: sumWidth, align: "right" });
    y += 9.5 * 1.45 + 1.2 * MM;
  }
  doc
    .moveTo(sumX, y)
    .lineTo(sumX + sumWidth, y)
    .lineWidth(0.3 * MM)
    .strokeColor(INK)
    .stroke();
  y += 3 * MM;
  write(labels.total, sumX, y, { weight: "extraBold", size: 14, width: sumWidth / 2 });
  write(totalText, sumX, y, { weight: "extraBold", size: 14, width: sumWidth, align: "right" });
  y += 14 * 1.45 + 1.2 * MM;

  // The notices, each under its title, side by side.
  const notices = [
    { title: labels.conditions, body: invoice.terms },
    { title: labels.legal, body: invoice.legal }
  ].filter(({ body }) => body.trim() !== "");
  if (notices.length > 0) {
    const gap = 8 * MM;
    const width = (CONTENT - gap * (notices.length - 1)) / notices.length;
    const heights = notices.map(
      ({ body }) => 7.5 * 1.45 + 1.5 * MM + measure(body, "medium", 8.5, width)
    );
    y += 9 * MM;
    room(Math.max(...heights));
    notices.forEach(({ title, body }, index) => {
      const x = left + index * (width + gap);
      const h = label(title, x, y, width) + 1.5 * MM;
      write(body, x, y + h, { size: 8.5, width });
    });
    y += Math.max(...heights);
  }

  // « Payer en bitcoin »: the QR code of the link, beside it.
  const url = invoice.sent.link.url;
  const boxPadding = 5 * MM;
  const boxHeight = QR_SIZE + 2 * boxPadding;
  y += 9 * MM;
  room(boxHeight);
  doc.roundedRect(left, y, CONTENT, boxHeight, 3 * MM).fill(SAND);
  const qrX = left + boxPadding;
  const qrY = y + boxPadding;
  doc.roundedRect(qrX, qrY, QR_SIZE, QR_SIZE, 2 * MM).fill("#FFFFFF");
  const code = createQrCode(0, "M");
  code.addData(url);
  code.make();
  const count = code.getModuleCount();
  const quiet = 4;
  const module = (QR_SIZE - 2 * MM) / (count + quiet * 2);
  const origin = { x: qrX + 1 * MM + quiet * module, y: qrY + 1 * MM + quiet * module };
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (code.isDark(row, col)) {
        doc.rect(origin.x + col * module, origin.y + row * module, module + 0.01, module + 0.01);
      }
    }
  }
  doc.fill(INK);
  const howX = qrX + QR_SIZE + 8 * MM;
  const howWidth = left + CONTENT - boxPadding - howX;
  const titleWidth = textWidth(labels.pay, "extraBold", 15);
  const howHeight =
    15 * 1.45 +
    2 * MM +
    measure(labels.payHint, "medium", 9.5, howWidth) +
    4 * MM +
    measure(url, "medium", 7, howWidth);
  let howY = y + (boxHeight - howHeight) / 2;
  write(labels.pay, howX, howY, { weight: "extraBold", size: 15, width: howWidth });
  const logo = 6.5 * MM;
  doc
    .save()
    .translate(howX + titleWidth + 2.5 * MM, howY + (15 * 1.45 - logo) / 2)
    .scale(logo / 64);
  doc.path(BTC_CIRCLE).fill("#F7931A");
  doc.path(BTC_B).fill("#FFFFFF");
  doc.restore();
  howY += 15 * 1.45 + 2 * MM;
  howY += write(labels.payHint, howX, howY, { width: howWidth });
  howY += 4 * MM;
  write(url, howX, howY, { size: 7, width: howWidth, color: STONE, link: url });

  doc.end();
  return done;
}
