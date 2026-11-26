import { currencyDigits } from "./currencies.js";
import {
  InvalidOrderError,
  NetworkError,
  RateError,
  SattlemeError,
  UnsupportedCurrencyError
} from "./errors.js";
import { getJson, type HttpOptions } from "./http.js";
import {
  CLOCK_TOLERANCE_SECONDS,
  MAX_MINOR_UNITS,
  MAX_PRICE_EXPONENT,
  MAX_PRICE_LENGTH,
  MAX_RATE_AGE_SECONDS
} from "./protocol.js";
import { isObject } from "./text.js";
import type { Fiat, RateInfo } from "./types.js";

/*
 * Amounts in a currency, converted to sats on the integrator's server at the rate of the source it
 * chooses (SPEC.md, "Prices in a currency"). Amounts are exact integers end to end: the price of
 * one bitcoin is read as the exact decimal its source wrote, and the sats are rounded up to the
 * next whole sat, as the merchant's point of sale does: the merchant never receives less than the
 * price.
 */

const SATS_PER_BTC = 100_000_000n;

/** An exact positive decimal: `units` × 10^-`scale`. */
export type Decimal = { units: bigint; scale: number };

const DECIMAL = /^([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/;

/**
 * A price as an exact decimal: digits, an optional fraction and an optional exponent
 * (`"69025.1084416666694295"`, `"8e-8"`), MAX_PRICE_LENGTH characters at most, an exponent of
 * MAX_PRICE_EXPONENT at most either way, nothing around it. Null unless it is strictly positive.
 */
export function parseDecimal(value: unknown): Decimal | null {
  if (typeof value !== "string" || value.length > MAX_PRICE_LENGTH) return null;
  const match = DECIMAL.exec(value);
  if (!match) return null;
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  if (Math.abs(exponent) > MAX_PRICE_EXPONENT) return null;
  let units = BigInt(match[1]! + fraction);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    units *= 10n ** BigInt(-scale);
    scale = 0;
  }
  // The shortest exact writing: 69012.50 is 69012.5.
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n;
    scale -= 1;
  }
  return units > 0n ? { units, scale } : null;
}

/**
 * The text of a JSON number a source answered: the shortest decimal that reads back as the same
 * IEEE 754 double (ECMAScript's Number::toString, Python's repr, .NET's "R"). A source that writes
 * more digits than a double holds gets them rounded, in every implementation alike.
 */
export function numberText(value: number): string | null {
  return Number.isFinite(value) ? String(value) : null;
}

/** The plain decimal writing of an exact decimal: `69012.5`, `0.00000008`. */
export function formatDecimal({ units, scale }: Decimal): string {
  if (scale === 0) return units.toString();
  const digits = units.toString().padStart(scale + 1, "0");
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

export { currencyDigits };

/**
 * A price given as `{ amount: "24.50", currency: "CHF" }`, as integer minor units of its currency.
 * The currency is an ISO 4217 code of CURRENCY_DIGITS (upper case); the amount a string of digits
 * with at most the currency's decimals (trailing zeros aside), nothing around it: never a float,
 * never rounded. Throws InvalidOrderError (`fiat`).
 */
export function parseFiat(fiat: unknown): Fiat {
  if (!isObject(fiat)) throw new InvalidOrderError("fiat", "expected { amount, currency }");
  const { currency, amount } = fiat;
  const digits = typeof currency === "string" ? currencyDigits(currency) : null;
  if (typeof currency !== "string" || digits === null) {
    throw new InvalidOrderError("fiat", "currency: an ISO 4217 code in upper case, as CHF");
  }
  if (typeof amount !== "string") {
    throw new InvalidOrderError("fiat", 'amount: a string of digits, as "24.50" (never a float)');
  }
  const match = /^([0-9]{1,15})(?:\.([0-9]{1,15}))?$/.exec(amount);
  if (!match) throw new InvalidOrderError("fiat", 'amount: digits, as "24.50"');
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > digits) {
    throw new InvalidOrderError("fiat", `amount: ${currency} has ${digits} decimals at most`);
  }
  const minor =
    BigInt(match[1]!) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, "0") || "0");
  if (minor < 1n || minor > MAX_MINOR_UNITS) {
    throw new InvalidOrderError("fiat", "amount: more than 0, and not that large");
  }
  return {
    amount: formatDecimal({ units: minor, scale: digits }),
    currency,
    minor: minor.toString(),
    digits
  };
}

/**
 * Sats for `minor` units of a currency with `digits` decimals, at `price` (one bitcoin in that
 * currency), rounded up to the next whole sat, on integers:
 * ⌈minor × 10^8 × 10^scale / (units × 10^digits)⌉.
 */
export function minorToSats(minor: bigint, digits: number, price: Decimal): bigint {
  const dividend = minor * SATS_PER_BTC * 10n ** BigInt(price.scale);
  const divisor = price.units * 10n ** BigInt(digits);
  return (dividend + divisor - 1n) / divisor;
}

/**
 * Sats for a price in a currency at the given price of one bitcoin (a decimal string): exact,
 * rounded up to the next whole sat. `fiatToSats({ amount: "24.50", currency: "CHF" }, "69012")` is
 * 35502n (the exact quotient is 35501.07…). Throws InvalidOrderError for an invalid price in a
 * currency, RateError for an invalid price of one bitcoin.
 */
export function fiatToSats(fiat: { amount: string; currency: string }, price: string): bigint {
  const parsed = parseFiat(fiat);
  const decimal = parseDecimal(price);
  if (!decimal) throw new RateError("A price must be a decimal string above 0");
  return minorToSats(BigInt(parsed.minor), parsed.digits, decimal);
}

/** A price of one bitcoin, as a source gives it. */
export type RateQuote = {
  /** An exact decimal string: "69012.5". */
  price: string;
  /** Unix seconds: when the source set it, null (or absent) when it does not say. */
  time?: number | null;
};

/** The rate sources the package knows, by name. */
export const RATE_SOURCES = ["coingecko", "mempool", "opennode", "coinbase", "kraken"] as const;

/** A rate source the package knows: `"coingecko"`, `"mempool"`, `"opennode"`, `"coinbase"`, `"kraken"`. */
export type RateName = (typeof RATE_SOURCES)[number];

/**
 * Any other source: a function that gives the price of one bitcoin in `currency` (ISO 4217, upper
 * case), as an exact decimal string or `{ price, time }`; never a number, which may already have
 * lost digits. Throw UnsupportedCurrencyError when it has no price in that currency. An error of
 * this package it throws goes through as it is; any other becomes a RateError (its `cause`).
 */
export type CustomRateFunction = (
  currency: string,
  context: { signal?: AbortSignal | undefined }
) => Promise<string | RateQuote>;

/** Where the rate of an invoice in a currency comes from: a source's name, or your own function. */
export type RateSource = RateName | CustomRateFunction;

/**
 * The sources asked when the client is given none, in this order (SPEC.md, "Rate sources"): the
 * dated ones first (their price's age is checked), CoinGecko for its currencies, then mempool.space
 * for its 7; then the undated ones, Coinbase and Kraken (two exchanges), and OpenNode.
 */
export const DEFAULT_RATE_SOURCES: readonly RateName[] = Object.freeze([
  "coingecko",
  "mempool",
  "coinbase",
  "kraken",
  "opennode"
]);

/** Whether `value` is a RateSource. */
export function isRateSource(value: unknown): value is RateSource {
  return typeof value === "function" || (RATE_SOURCES as readonly unknown[]).includes(value);
}

/**
 * The sources `value` names, in the order they are asked: a source alone, or a non-empty list of
 * sources without the same name twice. Null when it is neither.
 */
export function rateSourceList(value: unknown): readonly RateSource[] | null {
  if (isRateSource(value)) return [value];
  if (!Array.isArray(value) || value.length === 0) return null;
  const sources = (value as unknown[]).slice();
  if (!sources.every(isRateSource)) return null;
  const names = sources.filter((source) => typeof source === "string");
  return new Set(names).size === names.length ? sources : null;
}

/** What a source may use. */
export type RateContext = {
  fetch: typeof fetch;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  /** CoinGecko's Demo key, for "coingecko". */
  coingeckoApiKey?: string | undefined;
};

/** A source, ready to ask. */
type Source = {
  readonly name: string;
  readonly fetchRate: (currency: string, context: RateContext) => Promise<RateQuote>;
};

function sourceOf(source: RateSource): Source {
  if (typeof source === "function") {
    return {
      name: "custom",
      fetchRate: async (currency, { signal }) => {
        let answer: unknown;
        try {
          answer = await source(currency, { signal });
        } catch (error) {
          if (signal?.aborted) throw signal.reason;
          if (error instanceof SattlemeError) throw error;
          throw new RateError("The custom rate source failed", { cause: error });
        }
        if (typeof answer === "string") return { price: answer };
        if (!isObject(answer)) throw new RateError("The custom rate source gave no price");
        return answer as RateQuote;
      }
    };
  }
  switch (source) {
    case "coingecko":
      return coingecko;
    case "mempool":
      return mempool;
    case "opennode":
      return opennode;
    case "coinbase":
      return coinbase;
    case "kraken":
      return kraken;
    default:
      throw new RateError(`No rate source named ${String(source)}`);
  }
}

/**
 * The price of one bitcoin in `currency` from `source`, checked: an exact positive decimal, not
 * older than MAX_RATE_AGE_SECONDS, not further ahead than CLOCK_TOLERANCE_SECONDS. Undated
 * sources (OpenNode, Coinbase, Kraken, most custom ones) cannot be checked for age. Throws UnsupportedCurrencyError when the
 * source has no price in the currency, NetworkError when it does not answer, RateError for
 * anything else.
 */
export async function fetchRate(
  source: RateSource,
  currency: string,
  context: RateContext,
  now: number
): Promise<{ price: Decimal; info: RateInfo }> {
  const { name, fetchRate: fetchQuote } = sourceOf(source);
  const quote = await fetchQuote(currency, context);
  const price = parseDecimal(quote?.price);
  if (!price) throw new RateError(`${name} gave no valid price in ${currency}`);
  const time = quote.time ?? null;
  if (time !== null) {
    if (!Number.isSafeInteger(time) || time > now + CLOCK_TOLERANCE_SECONDS) {
      throw new RateError(`${name} gave an invalid date for its price`);
    }
    if (now - time > MAX_RATE_AGE_SECONDS) {
      throw new RateError(`${name}'s price in ${currency} is too old`);
    }
  }
  return {
    price,
    info: {
      source: name,
      currency,
      price: formatDecimal(price),
      fetchedAt: now,
      time
    }
  };
}

/** Logs a source's failure that the next source of a list replaces. */
export type RateLogger = { warn(message: string): void };

/**
 * The first usable price of `sources`, asked one at a time in their order (SPEC.md, "Rate
 * sources"): the next source only when the previous one gives no usable price (NetworkError,
 * RateError or UnsupportedCurrencyError, each logged). A cancellation, or any other error a custom
 * source throws, stops the list. With no price: UnsupportedCurrencyError when no source has the
 * currency, else the last NetworkError or RateError.
 */
export async function fetchFirstRate(
  sources: readonly RateSource[],
  currency: string,
  context: RateContext,
  now: () => number,
  logger: RateLogger,
  ask: typeof fetchRate = fetchRate
): Promise<{ price: Decimal; info: RateInfo }> {
  let failure: NetworkError | RateError | null = null;
  let unsupported: UnsupportedCurrencyError | null = null;
  for (const [index, source] of sources.entries()) {
    try {
      return await ask(source, currency, context, now());
    } catch (error) {
      if (context.signal?.aborted) throw context.signal.reason;
      if (error instanceof UnsupportedCurrencyError) unsupported = error;
      else if (error instanceof NetworkError || error instanceof RateError) failure = error;
      else throw error;
      const next = sources[index + 1];
      if (next !== undefined) {
        logger.warn(
          `Rate source ${sourceName(source)} failed (${error.code}): ${error.message}; trying ${sourceName(next)}`
        );
      }
    }
  }
  if (failure) throw failure;
  if (sources.length > 1) {
    const names = sources.map(sourceName).join(", ");
    throw new UnsupportedCurrencyError(
      currency,
      names,
      `None of ${names} has a price in ${currency}`
    );
  }
  throw unsupported!;
}

function sourceName(source: RateSource): string {
  return typeof source === "function" ? "custom" : source;
}

/** GET a source's JSON object: NetworkError without an answer, RateError for anything else. */
async function sourceJson(
  name: string,
  url: string,
  context: RateContext,
  headers?: Record<string, string>
): Promise<Record<string, unknown>> {
  const http: HttpOptions = {
    fetch: context.fetch,
    timeoutMs: context.timeoutMs,
    signal: context.signal,
    ...(headers ? { headers } : {})
  };
  const { status, ok, body } = await getJson(url, http);
  if (!ok) {
    // Only 5xx (500 to 599), 408 and 429 say "try again" (SPEC.md §26).
    if ((status >= 500 && status <= 599) || status === 408 || status === 429) {
      throw new NetworkError(`${name} answered HTTP ${status}`);
    }
    throw new RateError(`${name} answered HTTP ${status}`);
  }
  if (!isObject(body)) throw new RateError(`${name} gave no JSON object`);
  return body;
}

function objectAt(value: unknown, name: string): Record<string, unknown> {
  if (!isObject(value)) throw new RateError(`${name}: unexpected answer`);
  return value;
}

/** A source's price: a string as written, a JSON number as its shortest decimal (numberText). */
function priceOf(value: unknown, name: string, currency: string): string {
  if (value === undefined) throw new UnsupportedCurrencyError(currency, name);
  const text =
    typeof value === "string" ? value : typeof value === "number" ? numberText(value) : null;
  if (text === null) throw new RateError(`${name}: unexpected price`);
  return text;
}

/**
 * CoinGecko (`/simple/price`, dated with `include_last_updated_at`). Without a key, limited by IP
 * and, by CoinGecko's terms, not meant for production: give a Demo key (`coingeckoApiKey`).
 */
const coingecko: Source = {
  name: "coingecko",
  fetchRate: async (currency, context) => {
    const code = currency.toLowerCase();
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=${code}&include_last_updated_at=true`;
    const headers = context.coingeckoApiKey
      ? { "x-cg-demo-api-key": context.coingeckoApiKey }
      : undefined;
    const body = await sourceJson("coingecko", url, context, headers);
    const bitcoin = objectAt(body.bitcoin, "coingecko");
    const time = bitcoin.last_updated_at;
    return {
      price: priceOf(bitcoin[code], "coingecko", currency),
      time: typeof time === "number" ? time : null
    };
  }
};

/** The currencies of mempool.space's `/api/v1/prices`. */
const MEMPOOL_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "CHF", "AUD", "JPY"];

/** mempool.space (`/api/v1/prices`, dated): 7 currencies. */
const mempool: Source = {
  name: "mempool",
  fetchRate: async (currency, context) => {
    if (!MEMPOOL_CURRENCIES.includes(currency)) {
      throw new UnsupportedCurrencyError(currency, "mempool");
    }
    const body = await sourceJson("mempool", "https://mempool.space/api/v1/prices", context);
    const time = body.time;
    if (typeof time !== "number") throw new RateError("mempool: no time");
    return { price: priceOf(body[currency], "mempool", currency), time };
  }
};

/** OpenNode (`/v1/rates`): some 140 currencies, undated. */
const opennode: Source = {
  name: "opennode",
  fetchRate: async (currency, context) => {
    const body = await sourceJson("opennode", "https://api.opennode.com/v1/rates", context);
    const data = objectAt(body.data, "opennode");
    const pair = data[`BTC${currency}`];
    if (pair === undefined) throw new UnsupportedCurrencyError(currency, "opennode");
    return { price: priceOf(objectAt(pair, "opennode")[currency], "opennode", currency) };
  }
};

/** Coinbase (`/v2/exchange-rates?currency=BTC`): prices as decimal strings, read as written. */
const coinbase: Source = {
  name: "coinbase",
  fetchRate: async (currency, context) => {
    const body = await sourceJson(
      "coinbase",
      "https://api.coinbase.com/v2/exchange-rates?currency=BTC",
      context
    );
    const data = objectAt(body.data, "coinbase");
    if (data.currency !== "BTC") throw new RateError("coinbase: not the rates of BTC");
    return { price: priceOf(objectAt(data.rates, "coinbase")[currency], "coinbase", currency) };
  }
};

/**
 * Kraken (`/0/public/Ticker?pair=XBT<currency>`): the last trade's price (`c[0]`). The result's
 * key is not always the pair asked (XBTUSD gives XXBTZUSD): its only entry is read.
 */
const kraken: Source = {
  name: "kraken",
  fetchRate: async (currency, context) => {
    const body = await sourceJson(
      "kraken",
      `https://api.kraken.com/0/public/Ticker?pair=XBT${currency}`,
      context
    );
    const errors = body.error;
    if (!Array.isArray(errors)) throw new RateError("kraken: unexpected answer");
    if (errors.some((e) => typeof e === "string" && e.startsWith("EQuery:Unknown asset pair"))) {
      throw new UnsupportedCurrencyError(currency, "kraken");
    }
    if (errors.length > 0) throw new RateError(`kraken: ${String(errors[0])}`);
    const entries = Object.values(objectAt(body.result, "kraken"));
    if (entries.length !== 1) throw new RateError("kraken: unexpected answer");
    const last = objectAt(entries[0], "kraken").c;
    if (!Array.isArray(last)) throw new RateError("kraken: unexpected answer");
    return { price: priceOf(last[0], "kraken", currency) };
  }
};
