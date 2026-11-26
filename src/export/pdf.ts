import PDFDocument from "pdfkit";

import { clean, loadFonts } from "../pdf/invoice-pdf.js";

import type { Report } from "./report.js";

/*
 * The export's PDF (SPEC.md §20), laid out as the merchant's app's « Simple (PDF) » lays it out
 * (src/features/wallet/export/report-html.ts of the app): A4, its margins (16 and 18 mm), the
 * sattle.me logo alone at its head and foot, the business's name, the title, when it was made, the
 * period on a sand band, the summary's blocks, then the list of the lines (its header again at the
 * top of each page) and the note on the values. The texts are the report's (report.ts), checked
 * against the app's; drawn with pdfkit, as the invoice's PDF, with the app's measures.
 */

const MM = 72 / 25.4;
const PAGE = { width: 210 * MM, height: 297 * MM };
const MARGINS = { top: 16 * MM, right: 18 * MM, bottom: 16 * MM, left: 18 * MM };
const CONTENT = PAGE.width - MARGINS.left - MARGINS.right;
const BOTTOM = PAGE.height - MARGINS.bottom;
const INK = "#0B1A33";
const STONE = "#6E675E";
const SAND = "#F2ECE0";
/** rgba(11, 26, 51, 0.35) and rgba(11, 26, 51, 0.14) on white. */
const RULE = "#AAAFB8";
const HAIRLINE = "#DDDFE2";

/** The sattle.me logo (the app's report, its viewBox 890.4 × 153.8). */
const LOGO_WIDTH = 890.4;
const LOGO_HEIGHT = 153.8;
const LOGO_PATHS = [
  {
    fill: "#0B1A33",
    d: "M49.4 153.8Q31.4 153.8 18.1 145.3Q4.8 136.8 0 122.4L22 112Q26.2 120.8 33.4 125.8Q40.6 130.8 49.4 130.8Q55.8 130.8 59.2 128.2Q62.6 125.6 62.6 121Q62.6 118.6 61.4 116.9Q60.2 115.2 57.8 113.8Q55.4 112.4 51.8 111.4L33.2 106.2Q19.8 102.4 12.6 93.9Q5.4 85.4 5.4 73.8Q5.4 63.6 10.6 56Q15.8 48.4 25.2 44.1Q34.6 39.8 46.8 39.8Q62.8 39.8 74.9 47.3Q87 54.8 92 68.4L69.8 78.8Q67.4 72 61.1 67.9Q54.8 63.8 46.8 63.8Q41 63.8 37.7 66.2Q34.4 68.6 34.4 72.8Q34.4 75 35.6 76.8Q36.8 78.6 39.5 80Q42.2 81.4 46.2 82.6L63.6 87.8Q77.2 91.8 84.4 99.9Q91.6 108 91.6 119.8Q91.6 130 86.3 137.6Q81 145.2 71.6 149.5Q62.2 153.8 49.4 153.8ZM141 153.8Q129.2 153.8 120.6 150Q112 146.2 107.4 139.1Q102.8 132 102.8 122.2Q102.8 113 107 105.9Q111.2 98.8 119.9 94Q128.6 89.2 141.6 87.2L171.8 82.4V79.4Q171.8 73.2 166.9 69Q162 64.8 153.6 64.8Q145.6 64.8 139.5 69.2Q133.4 73.6 130.6 80.8L106.6 69.4Q109.8 60.2 116.8 53.6Q123.8 47 133.6 43.4Q143.4 39.8 155 39.8Q168.8 39.8 179.4 44.8Q190 49.8 195.9 58.7Q201.8 67.6 201.8 79.4V151.4H173.8V141Q172 143 170 144.4Q164.2 149.2 157 151.5Q149.8 153.8 141 153.8ZM171.8 104.4 147 108.8Q140.6 110 137.2 112.9Q133.8 115.8 133.8 121.2Q133.8 126.2 137.6 129Q141.4 131.8 147 131.8Q154.4 131.8 160 128.6Q165.6 125.4 168.7 119.9Q171.8 114.4 171.8 107.8ZM274 152.6Q254.2 152.6 243.3 141.9Q232.4 131.2 232.4 112V68.2H214V42.2H215Q223.4 42.2 227.9 38Q232.4 33.8 232.4 25.4V17.4H262.4V42.2H288V68.2H262.4V110Q262.4 115.6 264.4 119.3Q266.4 123 270.6 124.8Q274.8 126.6 281 126.6Q282.4 126.6 284.2 126.4Q286 126.2 288 126V151.4Q285 151.8 281.2 152.2Q277.4 152.6 274 152.6ZM355.8 152.6Q336 152.6 325.1 141.9Q314.2 131.2 314.2 112V68.2H295.8V42.2H296.8Q305.2 42.2 309.7 38Q314.2 33.8 314.2 25.4V17.4H344.2V42.2H369.8V68.2H344.2V110Q344.2 115.6 346.2 119.3Q348.2 123 352.4 124.8Q356.6 126.6 362.8 126.6Q364.2 126.6 366 126.4Q367.8 126.2 369.8 126V151.4Q366.8 151.8 363 152.2Q359.2 152.6 355.8 152.6ZM385 151.4V0H415V151.4ZM487.2 153.8Q469.8 153.8 457 146.1Q444.2 138.4 437.2 125.4Q430.2 112.4 430.2 96.6Q430.2 80.2 437.5 67.4Q444.8 54.6 457.2 47.2Q469.6 39.8 485.2 39.8Q498.2 39.8 508.2 43.9Q518.2 48 525.1 55.4Q532 62.8 535.6 72.5Q539.2 82.2 539.2 93.6Q539.2 96.8 538.9 99.9Q538.6 103 537.8 105.2H461.4Q461.8 109.4 463.4 113Q466.4 120 472.6 123.9Q478.8 127.8 487.6 127.8Q495.6 127.8 501.3 124.6Q507 121.4 510.2 115.8L534.2 127.2Q531 135.2 524.1 141.2Q517.2 147.2 507.8 150.5Q498.4 153.8 487.2 153.8ZM462 83.2H507.4Q507.2 80.6 506.4 78.2Q504.2 71.6 498.7 67.7Q493.2 63.8 485.2 63.8Q477.4 63.8 471.8 67.6Q466.2 71.4 463.4 78.8Q462.6 80.8 462 83.2Z"
  },
  { fill: "#F7931A", d: "M551.2 131.8A19.6 19.6 0 1 0 590.4 131.8A19.6 19.6 0 1 0 551.2 131.8Z" },
  {
    fill: "#F7931A",
    d: "M602.4 151.4V42.2H630.4V55.4Q633.4 49.4 639 45.8Q648.2 39.8 661 39.8Q674.6 39.8 685 46.6Q691 50.8 694.2 56.4Q698.6 50 704.6 46.2Q714.6 39.8 728 39.8Q739.8 39.8 748.9 45Q758 50.2 763.2 59.5Q768.4 68.8 768.4 81.2V151.4H738.4V87.6Q738.4 81.2 736.1 76.6Q733.8 72 729.6 69.4Q725.4 66.8 719.4 66.8Q713.6 66.8 709.3 69.4Q705 72 702.7 76.6Q700.4 81.2 700.4 87.6V151.4H670.4V87.6Q670.4 81.2 668.1 76.6Q665.8 72 661.6 69.4Q657.4 66.8 651.4 66.8Q645.6 66.8 641.3 69.4Q637 72 634.7 76.6Q632.4 81.2 632.4 87.6V151.4ZM838.4 153.8Q821 153.8 808.2 146.1Q795.4 138.4 788.4 125.4Q781.4 112.4 781.4 96.6Q781.4 80.2 788.7 67.4Q796 54.6 808.4 47.2Q820.8 39.8 836.4 39.8Q849.4 39.8 859.4 43.9Q869.4 48 876.3 55.4Q883.2 62.8 886.8 72.5Q890.4 82.2 890.4 93.6Q890.4 96.8 890.1 99.9Q889.8 103 889 105.2H812.6Q813 109.4 814.6 113Q817.6 120 823.8 123.9Q830 127.8 838.8 127.8Q846.8 127.8 852.5 124.6Q858.2 121.4 861.4 115.8L885.4 127.2Q882.2 135.2 875.3 141.2Q868.4 147.2 859 150.5Q849.6 153.8 838.4 153.8ZM813.2 83.2H858.6Q858.4 80.6 857.6 78.2Q855.4 71.6 849.9 67.7Q844.4 63.8 836.4 63.8Q828.6 63.8 823 67.6Q817.4 71.4 814.6 78.8Q813.8 80.8 813.2 83.2Z"
  }
];

type Weight = "medium" | "bold" | "extraBold";

/** The report's columns' widths (mm), the label's taking what is left. */
const COLUMNS = { source: 26, by: 24, remark: 34, amount: 32 };

/**
 * The PDF of `report`, made at `madeAt` (its metadata), with `notes` of the assistant's after the
 * app's note on the values (notes.ts).
 */
export async function exportPdf(
  report: Report,
  madeAt: Date,
  notes: readonly string[] = []
): Promise<Buffer> {
  const loaded = loadFonts();
  const doc = new PDFDocument({
    size: [PAGE.width, PAGE.height],
    margins: MARGINS,
    autoFirstPage: true,
    info: {
      Title: report.title,
      Author: report.businessName,
      Creator: "sattle.me",
      CreationDate: madeAt
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

  const font = (weight: Weight, size: number, ratio = 1.3) => {
    doc.font(weight).fontSize(size);
    const gap = Math.max(0, size * ratio - doc.currentLineHeight(false));
    return { lineGap: gap, features: ["tnum"] as PDFKit.Mixins.OpenTypeFeatures[] };
  };
  type Style = {
    weight?: Weight;
    size?: number;
    width: number;
    color?: string;
    align?: "left" | "right" | "center";
    ratio?: number;
  };
  const options = ({ weight = "medium", size = 10, width, align = "left", ratio }: Style) => ({
    ...font(weight, size, ratio),
    width,
    align,
    lineBreak: true
  });
  const measure = (text: string, style: Style) => doc.heightOfString(clean(text), options(style));
  const write = (text: string, x: number, y: number, style: Style): number => {
    const used = options(style);
    doc.fillColor(style.color ?? INK).text(clean(text), x, y, used);
    return doc.heightOfString(clean(text), used);
  };
  const logo = (x: number, y: number, height: number) => {
    const scale = height / LOGO_HEIGHT;
    for (const { fill, d } of LOGO_PATHS) {
      doc.save().translate(x, y).scale(scale).path(d).fill(fill).restore();
    }
  };

  // The head: the logo, the business, the title, when it was made, the period.
  let y = MARGINS.top;
  logo(MARGINS.left, y, 8 * MM);
  y += 8 * MM + 14 * MM;
  y += write(report.businessName, MARGINS.left, y, {
    weight: "bold",
    size: 12,
    width: CONTENT,
    align: "right"
  });
  y += 22 * MM;
  y += write(report.title, MARGINS.left, y, { weight: "extraBold", size: 24, width: CONTENT });
  y += 4 * MM;
  y += write(report.made, MARGINS.left, y, { size: 11, width: CONTENT });
  y += 8 * MM;
  const band = {
    weight: "bold" as const,
    size: 11,
    width: CONTENT - 8 * MM,
    align: "right" as const
  };
  const bandHeight = measure(report.period, band) + 6 * MM;
  doc.rect(MARGINS.left, y, CONTENT, bandHeight).fill(SAND);
  write(report.period, MARGINS.left + 4 * MM, y + 3 * MM, band);
  y += bandHeight + 4 * MM;

  /** A new page when `height` does not fit below `y`. */
  const room = (height: number): boolean => {
    if (y + height <= BOTTOM) return false;
    doc.addPage();
    y = MARGINS.top;
    return true;
  };

  // The summary, block by block: a label at the left, its value at the right.
  for (const block of report.summary) {
    y += 5 * MM;
    for (const line of block) {
      const style: Style =
        line.kind === "lead"
          ? { weight: "bold", size: 10.5, width: CONTENT - 10 * MM }
          : { size: 9.5, width: CONTENT - 10 * MM, color: STONE };
      const height = measure(line.label || " ", style) + 2 * MM;
      room(height);
      write(line.value, MARGINS.left + 5 * MM, y + MM, { ...style, align: "right" });
      write(line.label, MARGINS.left + 5 * MM, y + MM, {
        ...style,
        width: CONTENT - 10 * MM - doc.widthOfString(clean(line.value)) - 4 * MM
      });
      y += height;
    }
  }

  // The list of the lines.
  room(30 * MM);
  y += 8 * MM;
  doc
    .moveTo(MARGINS.left, y)
    .lineTo(MARGINS.left + CONTENT, y)
    .lineWidth(0.25 * MM)
    .stroke(RULE);
  y += 7 * MM;
  y += write(report.linesTitle, MARGINS.left, y, { weight: "extraBold", size: 12, width: CONTENT });
  y += 3 * MM;
  if (report.header === null) {
    y += write(report.none ?? "", MARGINS.left, y, { width: CONTENT, color: STONE });
  } else {
    // The date on one line (the app's `white-space: nowrap`), as wide as the longest.
    font("medium", 9);
    const dateWidth =
      Math.max(...report.rows.map(([date = ""]) => doc.widthOfString(clean(date))), 20 * MM) +
      3 * MM +
      1;
    const widths = [
      dateWidth,
      0,
      COLUMNS.source * MM,
      COLUMNS.by * MM,
      ...(report.remarks ? [COLUMNS.remark * MM] : []),
      COLUMNS.amount * MM
    ];
    widths[1] = CONTENT - widths.reduce((sum, width) => sum + width, 0);
    const last = widths.length - 1;
    const xs = widths.map(
      (_, index) => MARGINS.left + widths.slice(0, index).reduce((sum, width) => sum + width, 0)
    );
    const cellWidth = (index: number) => widths[index]! - (index === last ? 0 : 3 * MM);
    const header = () => {
      const style = (index: number): Style => ({
        weight: "bold",
        size: 8.5,
        width: cellWidth(index),
        color: STONE,
        align: index === last ? "right" : "left"
      });
      const height =
        Math.max(...report.header!.map((name, index) => measure(name, style(index)))) + 2 * MM;
      report.header!.forEach((name, index) => write(name, xs[index]!, y, style(index)));
      y += height;
      doc
        .moveTo(MARGINS.left, y)
        .lineTo(MARGINS.left + CONTENT, y)
        .lineWidth(0.25 * MM)
        .stroke(RULE);
    };
    header();
    for (const row of report.rows) {
      const style = (index: number): Style => {
        const remark = report.remarks && index === last - 1;
        return {
          size: remark ? 8 : 9,
          width: cellWidth(index),
          color: remark ? STONE : INK,
          align: index === last ? "right" : "left"
        };
      };
      const height = Math.max(...row.map((cell, index) => measure(cell, style(index)))) + 4 * MM;
      if (room(height)) header();
      row.forEach((cell, index) => write(cell, xs[index]!, y + 2 * MM, style(index)));
      y += height;
      doc
        .moveTo(MARGINS.left, y)
        .lineTo(MARGINS.left + CONTENT, y)
        .lineWidth(0.25 * MM)
        .stroke(HAIRLINE);
    }
  }
  const style: Style = { size: 8, width: CONTENT, color: STONE, ratio: 1.5 };
  let gap = 6 * MM;
  for (const note of [...(report.notes === null ? [] : [report.notes]), ...notes]) {
    room(measure(note, style) + gap);
    y += gap;
    y += write(note, MARGINS.left, y, style);
    gap = 2 * MM;
  }
  // The foot: the logo, centred.
  room(17 * MM);
  y += 12 * MM;
  const footWidth = (5 * MM * LOGO_WIDTH) / LOGO_HEIGHT;
  logo(MARGINS.left + (CONTENT - footWidth) / 2, y, 5 * MM);
  doc.end();
  return done;
}
