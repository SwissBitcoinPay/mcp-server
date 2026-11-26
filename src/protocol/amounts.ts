import {
  MAX_CURRENCY_DIGITS,
  MAX_LINE_NAME,
  MAX_LINES,
  MAX_MAJOR_UNITS,
  MAX_QUANTITY,
  MAX_VAT_RATE
} from "./constants.js";
import { isFilledText } from "./text.js";

/*
 * An invoice's amounts (SPEC.md §8), exact: integers end to end, in bigint wherever a product may
 * pass 2^53, formatted only for display. Two roundings, half up, as the merchant's app writes them
 * (src/lib/invoice/amounts.ts): a line's amount when its quantity has hundredths, and each VAT
 * rate's tax on the sum of its lines.
 */

/** One line of an invoice. */
export type InvoiceLine = {
  /** Its designation, not blank. */
  name: string;
  /** Hundredths of a unit: 100 is one. */
  quantity: number;
  /** The price of one unit before VAT, in minor units of the invoice's currency. */
  unitMinor: number;
  /** Basis points: 810 is 8.1 %. */
  vatRate: number;
};

export type VatGroup = { rate: number; baseMinor: number; vatMinor: number };

export type InvoiceTotals = {
  netMinor: number;
  /** One group per rate above 0, the lowest rate first. */
  vat: VatGroup[];
  totalMinor: number;
};

/** The largest amount of a currency of `digits` digits, in minor units: 99 999.99 for 2. */
export function largestMinor(digits: number): number {
  const scale = 10 ** digits;
  return MAX_MAJOR_UNITS * scale + scale - 1;
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator);
}

function isBetween(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function isValidLine(line: InvoiceLine, digits: number): boolean {
  return (
    isFilledText(line.name, MAX_LINE_NAME) &&
    isBetween(line.quantity, 1, MAX_QUANTITY) &&
    isBetween(line.unitMinor, 0, largestMinor(digits)) &&
    isBetween(line.vatRate, 0, MAX_VAT_RATE)
  );
}

/** A line's amount before VAT: quantity × unit price / 100, half up. */
export function lineNetMinor(line: Pick<InvoiceLine, "quantity" | "unitMinor">): bigint {
  return roundHalfUp(BigInt(line.quantity) * BigInt(line.unitMinor), 100n);
}

/**
 * The totals of `lines`, every line valid, in bigint: the caller checks them against the largest
 * amount before taking them as numbers (invoiceTotals).
 */
function totalsOf(lines: readonly InvoiceLine[]): {
  net: bigint;
  vat: { rate: number; base: bigint; tax: bigint }[];
  total: bigint;
} {
  const bases = new Map<number, bigint>();
  let net = 0n;
  for (const line of lines) {
    const amount = lineNetMinor(line);
    net += amount;
    bases.set(line.vatRate, (bases.get(line.vatRate) ?? 0n) + amount);
  }
  const vat = [...bases.entries()]
    .filter(([rate]) => rate > 0)
    .sort(([a], [b]) => a - b)
    .map(([rate, base]) => ({ rate, base, tax: roundHalfUp(base * BigInt(rate), 10_000n) }));
  return { net, vat, total: net + vat.reduce((sum, group) => sum + group.tax, 0n) };
}

/**
 * Whether `lines` make an invoice that can be sent: 1 to MAX_LINES lines, each valid, and a total
 * above zero and at most the largest amount.
 */
export function isPayable(lines: readonly InvoiceLine[], digits: number): boolean {
  if (!isBetween(digits, 0, MAX_CURRENCY_DIGITS)) return false;
  if (lines.length === 0 || lines.length > MAX_LINES) return false;
  if (!lines.every((line) => isValidLine(line, digits))) return false;
  const { total } = totalsOf(lines);
  return total > 0n && total <= BigInt(largestMinor(digits));
}

/** The totals of payable `lines` (isPayable): every amount at most the largest, a safe integer. */
export function invoiceTotals(lines: readonly InvoiceLine[], digits: number): InvoiceTotals {
  if (!isPayable(lines, digits)) throw new Error("The lines do not make a payable invoice");
  const { net, vat, total } = totalsOf(lines);
  return {
    netMinor: Number(net),
    vat: vat.map(({ rate, base, tax }) => ({
      rate,
      baseMinor: Number(base),
      vatMinor: Number(tax)
    })),
    totalMinor: Number(total)
  };
}

/**
 * A decimal given as text (by a person or a model), as an integer of `decimals` decimals: "1.5"
 * with 2 is 150. Digits, then optionally "." and digits; never more decimals than `decimals` (it
 * never rounds what it was given), never a sign, an exponent nor a group separator. Null when it
 * is not one, or above `max`.
 */
export function parseScaled(text: unknown, decimals: number, max: number): number | null {
  if (typeof text !== "string") return null;
  const match = /^([0-9]{1,15})(?:\.([0-9]{1,15}))?$/.exec(text);
  if (!match) return null;
  const whole = match[1]!;
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > decimals) return null;
  const value =
    BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  return value <= BigInt(max) ? Number(value) : null;
}

/** An amount in minor units written with its currency's `digits`: 400432 with 2 is "4004.32". */
export function formatMinor(minor: number, digits: number): string {
  const text = String(minor).padStart(digits + 1, "0");
  return digits === 0 ? text : `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}
