import { getJson, hostOf, type HttpOptions } from "../../vendor/checkout-node/src/http.js";
import { NetworkError } from "../../vendor/checkout-node/src/errors.js";

import {
  COINGECKO_URL,
  DAY_SECONDS,
  HISTORY_DAYS,
  HOUR_SECONDS,
  HOURLY_DELAY_SECONDS,
  HOURLY_SPAN_SECONDS,
  POINT_DELAY_SECONDS
} from "./constants.js";
import { isObject } from "./text.js";

/*
 * Points of the hour (SPEC.md §9): CoinGecko's price of one bitcoin in a currency at an exact
 * hour, which prices a payment link hour by hour, as the merchant's app reads them
 * (src/lib/rates/sources.ts): the 5-minute series of the last day for a recent hour, hourly windows
 * otherwise, only entries exactly on an hour. A point is a price, never an amount: it converts to
 * sats exactly (satsAt), rounded up to the next whole sat.
 */

const SATS_PER_BTC = 100_000_000n;

/** The hour (Unix seconds) whose point prices the time `t`: the one that began 5 minutes before. */
export function pointHour(t: number): number {
  return Math.floor((t - POINT_DELAY_SECONDS) / HOUR_SECONDS) * HOUR_SECONDS;
}

/** When the point of `hour` stops pricing: 5 minutes after the next hour. */
export function pointEnd(hour: number): number {
  return hour + HOUR_SECONDS + POINT_DELAY_SECONDS;
}

/**
 * A price (a finite JSON number above 0) as an exact fraction of its decimal digits: the shortest
 * decimal that reads back as the number (ECMAScript's Number::toString), as the merchant's app reads
 * it (rateToFraction) and spec/SPEC.md §25 says.
 */
export function priceFraction(rate: number): { numerator: bigint; denominator: bigint } {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("Not a price");
  const text = rate.toString().includes("e") ? rate.toFixed(20) : rate.toString();
  const [whole = "", fraction = ""] = text.split(".");
  const numerator = BigInt(whole + fraction);
  if (numerator <= 0n) throw new Error("Not a price");
  return { numerator, denominator: 10n ** BigInt(fraction.length) };
}

/**
 * The sats of `minor` minor units of a currency of `digits` digits at the price `rate` of one
 * bitcoin: ceil(minor × 10^8 / (rate × 10^digits)), on integers.
 */
export function satsAt(minor: number, digits: number, rate: number): bigint {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error("Not an amount");
  const { numerator, denominator } = priceFraction(rate);
  const dividend = BigInt(minor) * SATS_PER_BTC * denominator;
  const divisor = numerator * 10n ** BigInt(digits);
  return (dividend + divisor - 1n) / divisor;
}

function isPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** A series asked: the 5-minute one of the last day, or a window of hourly points. */
type Series = "fiveMinute" | { from: number; to: number };

/** The points of one currency read during a call, by hour: a published point never changes. */
export class PointBook {
  readonly #currency: string;
  readonly #http: HttpOptions;
  readonly #points = new Map<number, number>();

  constructor(currency: string, http: HttpOptions) {
    if (!/^[A-Z]{3}$/.test(currency) || currency === "BTC") throw new Error("Not a fiat currency");
    this.#currency = currency;
    this.#http = http;
  }

  /** The points read so far. */
  get known(): ReadonlyMap<number, number> {
    return this.#points;
  }

  async #read(series: Series): Promise<void> {
    const vs = this.#currency.toLowerCase();
    const url =
      series === "fiveMinute"
        ? `${COINGECKO_URL}/coins/bitcoin/market_chart?vs_currency=${vs}&days=1`
        : `${COINGECKO_URL}/coins/bitcoin/market_chart/range` +
          `?vs_currency=${vs}&from=${series.from}&to=${series.to}`;
    const { ok, status, body } = await getJson(url, this.#http);
    if (!ok) throw new NetworkError(`${hostOf(url)} answered HTTP ${status}`);
    const prices = isObject(body) ? body.prices : undefined;
    if (!Array.isArray(prices)) throw new NetworkError(`${hostOf(url)} gave no prices`);
    // The 5-minute series ends with the live price, at any second: never a point.
    const settled = series === "fiveMinute" ? prices.slice(0, -1) : prices;
    for (const entry of settled as unknown[]) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const [ms, price] = entry as unknown[];
      if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms % (HOUR_SECONDS * 1000) !== 0) {
        continue;
      }
      if (!isPrice(price)) continue;
      this.#points.set(ms / 1000, price);
    }
  }

  /**
   * The point of `hour` at `now`, null while it is not published (or older than CoinGecko keeps).
   * Rejects (NetworkError) when CoinGecko fails or answers anything else than its points.
   */
  async point(hour: number, now: number): Promise<number | null> {
    if (!Number.isSafeInteger(hour) || hour % HOUR_SECONDS !== 0) throw new Error("Not an hour");
    const known = this.#points.get(hour);
    if (known !== undefined) return known;
    if (hour > now) return null;
    for (const series of this.#seriesOf(hour, now)) {
      await this.#read(series);
      const point = this.#points.get(hour);
      if (point !== undefined) return point;
    }
    return null;
  }

  /** The series that may hold the point of `hour` at `now`, in turn (SPEC.md §9). */
  #seriesOf(hour: number, now: number): Series[] {
    const recent = hour > now - DAY_SECONDS + HOUR_SECONDS;
    if (!recent) return [{ from: hour - DAY_SECONDS / 2, to: hour + DAY_SECONDS / 2 }];
    if (now - hour < HOURLY_DELAY_SECONDS) return ["fiveMinute"];
    return [
      "fiveMinute",
      { from: now - DAY_SECONDS, to: now },
      { from: now - 2 * DAY_SECONDS, to: now }
    ];
  }

  /**
   * The points of every hour from `from` to `to` (on hours) CoinGecko published: those of the last
   * day from the 5-minute series, older ones in windows of at most 89 days. An hour without a point
   * (not published yet, older than its history) is left out.
   */
  async points(from: number, to: number, now: number): Promise<ReadonlyMap<number, number>> {
    if (![from, to].every((t) => Number.isSafeInteger(t) && t % HOUR_SECONDS === 0)) {
      throw new Error("Not hours");
    }
    const oldest =
      Math.floor((now - (HISTORY_DAYS - 1) * DAY_SECONDS) / HOUR_SECONDS) * HOUR_SECONDS;
    const found = new Map<number, number>();
    let missing: number[] = [];
    for (let hour = Math.max(from, oldest); hour <= Math.min(to, now); hour += HOUR_SECONDS) {
      const known = this.#points.get(hour);
      if (known !== undefined) found.set(hour, known);
      else missing.push(hour);
    }
    while (missing.length > 0) {
      const first = missing[0]!;
      const recent = first > now - DAY_SECONDS + HOUR_SECONDS;
      if (recent) {
        // The last day: one point at a time from the series that hold it (the first read holds all).
        await this.point(first, now);
      } else {
        await this.#read({
          from: first - HOUR_SECONDS,
          to: Math.min(first + HOURLY_SPAN_SECONDS, now)
        });
      }
      const until = recent ? now : Math.min(first + HOURLY_SPAN_SECONDS, now);
      for (const hour of missing) {
        if (hour > until) break;
        const point = this.#points.get(hour);
        if (point !== undefined) found.set(hour, point);
      }
      missing = missing.filter((hour) => hour > until);
    }
    return found;
  }
}
