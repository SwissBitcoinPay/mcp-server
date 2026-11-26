/*
 * @sattleme/checkout: a shop's server takes Lightning and on-chain payments for a sattle.me
 * merchant. Everything runs on that server, which holds the integration's secret key;
 * the customer's browser only ever gets the invoice and its deposit address, or a checkout link to
 * it on the merchant's web app (`checkout: true`). The protocol, for implementations in other
 * languages: https://github.com/sattleme/checkout-spec (SPEC.md).
 *
 * The public API is the client, its types and its errors: every other module is internal and may
 * change in any version.
 */

export { Sattleme, type CallOptions, type SattlemeOptions, type WaitOptions } from "./client.js";
export type { Order } from "./order.js";
export {
  ChannelNotFoundError,
  CheckoutUnavailableError,
  InvalidInvoiceError,
  InvalidKeyError,
  InvalidOptionError,
  InvalidOrderError,
  InvoicePendingError,
  NetworkError,
  OnchainUnavailableError,
  OrderPaidError,
  RateError,
  RevokedError,
  SattlemeError,
  UnsupportedCurrencyError
} from "./errors.js";
export {
  DEFAULT_RATE_SOURCES,
  RATE_SOURCES,
  currencyDigits,
  fiatToSats,
  type CustomRateFunction,
  type RateName,
  type RateQuote,
  type RateSource
} from "./rates.js";
export type {
  DeclaredInvoice,
  Fiat,
  Invoice,
  InvoiceToCheck,
  Logger,
  Merchant,
  PaymentStatus,
  RateInfo,
  Rest
} from "./types.js";
export type { WebSocketLike } from "./nostr/relay.js";
