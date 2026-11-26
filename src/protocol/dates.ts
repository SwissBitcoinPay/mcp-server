import { DEFAULT_DUE_DAYS, MAX_DUE_MONTHS } from "./constants.js";

/*
 * Calendar dates (SPEC.md §2, §7): `YYYY-MM-DD` of the proleptic Gregorian calendar, and the due
 * date's end in a time zone, as the merchant's app computes them on the device's calendar
 * (dueRange, endOfDay): the assistant's time zone stands for the device's.
 */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar date's parts. */
export type Day = { year: number; month: number; day: number };

/** Whether `value` is a calendar date that exists, of a year from 2000 to 9999. */
export function isCalendarDate(value: unknown): value is string {
  return parseDay(value) !== null;
}

export function parseDay(value: unknown): Day | null {
  if (typeof value !== "string") return null;
  const match = DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1) return null;
  if (date.getUTCDate() !== day || year < 2000) return null;
  return { year, month, day };
}

export function formatDay({ year, month, day }: Day): string {
  const pad = (value: number, width: number) => String(value).padStart(width, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** The day `days` after `of` (negative: before). */
export function addDays(of: Day, days: number): Day {
  const date = new Date(Date.UTC(of.year, of.month - 1, of.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** Whether `timeZone` is an IANA time zone this runtime knows. */
export function isTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || timeZone === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** The calendar date of the instant `seconds` (Unix) in `timeZone`. */
export function dayAt(seconds: number, timeZone: string): Day {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      era: "short"
    });
    formats.set(timeZone, format);
  }
  const parts = format.formatToParts(new Date(seconds * 1000));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

function compare(a: Day, b: Day): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/**
 * The first and last due dates offered on the day of `now` in `timeZone`: the next day, and the
 * same day MAX_DUE_MONTHS later (the month's last when it has none).
 */
export function dueRange(now: number, timeZone: string): { first: string; last: string } {
  const today = dayAt(now, timeZone);
  const target = new Date(Date.UTC(today.year, today.month - 1 + MAX_DUE_MONTHS, 1));
  const lastOfMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  const last: Day = {
    year: target.getUTCFullYear(),
    month: target.getUTCMonth() + 1,
    day: Math.min(today.day, lastOfMonth)
  };
  return { first: formatDay(addDays(today, 1)), last: formatDay(last) };
}

/** The due date of an invoice the user named none for: DEFAULT_DUE_DAYS after today. */
export function defaultDueDate(now: number, timeZone: string): string {
  return formatDay(addDays(dayAt(now, timeZone), DEFAULT_DUE_DAYS));
}

/**
 * Unix seconds: the end of `date` in `timeZone`, the first second of the next day there (a
 * midnight that a change of time skips: the first second that day has).
 */
export function endOfDay(date: string, timeZone: string): number {
  const day = parseDay(date);
  if (!day) throw new Error("Not a calendar date");
  const next = addDays(day, 1);
  const midnight = Date.UTC(next.year, next.month - 1, next.day) / 1000;
  // Time zones are within 14 hours of UTC: the change of day is in this window.
  let low = midnight - 15 * 3600;
  let high = midnight + 15 * 3600;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compare(dayAt(middle, timeZone), next) >= 0) high = middle;
    else low = middle + 1;
  }
  return low;
}
