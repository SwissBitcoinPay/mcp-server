import type { DeclaredInvoice, PaymentStatus } from "./types.js";

/*
 * The errors of the package (SPEC.md, "Errors"). Every one says what failed, never with a secret: neither the
 * integration's key, nor a sale's key, nor any key derived from them is ever put in a message.
 * `retryable` tells whether the same call may succeed later as it is (a relay or a service down).
 * Every error the package throws is one of these, but for an aborted call: it rejects with the
 * reason of its `signal`.
 */

/** What every error of this package is. */
export class SattlemeError extends Error {
  /** A stable code, for programs: "invalid_key", "network"… */
  readonly code: string;
  /** Whether the same call may succeed later, unchanged. */
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SattlemeError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** Not an integration's secret key (`sattleme_ck_…`), or a damaged one. */
export class InvalidKeyError extends SattlemeError {
  constructor(message = "Not a sattle.me integration key") {
    super("invalid_key", message);
    this.name = "InvalidKeyError";
  }
}

/**
 * An option of the client or of a call is invalid (a programming error, found before any request):
 * `param` names it.
 */
export class InvalidOptionError extends SattlemeError {
  readonly param: string;

  constructor(param: string, message: string) {
    super("invalid_option", `${param}: ${message}`);
    this.name = "InvalidOptionError";
    this.param = param;
  }
}

/** A parameter of the order is invalid: `param` names it. */
export class InvalidOrderError extends SattlemeError {
  readonly param: string;

  constructor(param: string, message: string) {
    super("invalid_order", `${param}: ${message}`);
    this.name = "InvalidOrderError";
    this.param = param;
  }
}

/**
 * A relay, the Lightning address's server, a rate source or an explorer did not answer (in time),
 * or fewer relays than needed did. Retry later.
 */
export class NetworkError extends SattlemeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("network", message, true, options);
    this.name = "NetworkError";
  }
}

/** The merchant removed the integration: no invoice can be made with this key any more. */
export class RevokedError extends SattlemeError {
  constructor() {
    super("revoked", "The merchant removed this integration");
    this.name = "RevokedError";
  }
}

/**
 * The relays answered, but none holds the integration's channel (or only one of a newer format
 * than this version of the package reads: `newerFormat`).
 */
export class ChannelNotFoundError extends SattlemeError {
  readonly newerFormat: boolean;

  constructor(newerFormat: boolean) {
    super(
      "channel_not_found",
      newerFormat
        ? "The integration's channel is of a newer format: update @sattleme/checkout"
        : "The integration's channel was not found on its relays",
      !newerFormat
    );
    this.name = "ChannelNotFoundError";
    this.newerFormat = newerFormat;
  }
}

/**
 * An invoice, or a payment answer, that fails the checks: another network, amount, merchant,
 * duration or date, a verify answer about another invoice, a preimage that does not match. Never
 * show such an invoice.
 */
export class InvalidInvoiceError extends SattlemeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("invalid_invoice", message, false, options);
    this.name = "InvalidInvoiceError";
  }
}

/** The rate source has no price in this currency. */
export class UnsupportedCurrencyError extends SattlemeError {
  readonly currency: string;

  constructor(currency: string, source: string, message = `${source} has no price in ${currency}`) {
    super("unsupported_currency", message);
    this.name = "UnsupportedCurrencyError";
    this.currency = currency;
  }
}

/**
 * No usable rate: a source answered something that is not a price, a price too old, or a custom
 * source failed (`cause`). Retry later, or with another source.
 */
export class RateError extends SattlemeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("rate", message, true, options);
    this.name = "RateError";
  }
}

/**
 * The order still has an invoice that may be paid (not expired, or in the 120 s after its end):
 * show that one (`invoice`) instead of making another. One order, one invoice at a time. When the
 * order asked for a checkout link, `checkoutUrl` is a new link to that invoice, else null.
 */
export class InvoicePendingError extends SattlemeError {
  readonly invoice: DeclaredInvoice;
  readonly checkoutUrl: string | null;

  constructor(invoice: DeclaredInvoice, checkoutUrl: string | null = null) {
    super("invoice_pending", "This order still has an invoice that may be paid");
    this.name = "InvoicePendingError";
    this.invoice = invoice;
    this.checkoutUrl = checkoutUrl;
  }
}

/**
 * A checkout link was asked, and the merchant's app gives no web app for it (its channel names
 * none: a version of the app without a web app). Make the invoice without `checkout`, and show it
 * on the shop's page.
 */
export class CheckoutUnavailableError extends SattlemeError {
  constructor() {
    super(
      "checkout_unavailable",
      "The merchant's app gives no web app for checkout links: show the invoice on the shop's page"
    );
    this.name = "CheckoutUnavailableError";
  }
}

/**
 * The order was already paid, with `invoice`: `status` is its `paid` status, `preimage` the proof
 * of a Lightning payment (null when it was paid on-chain). Never charge it again.
 */
export class OrderPaidError extends SattlemeError {
  readonly invoice: DeclaredInvoice;
  readonly status: Extract<PaymentStatus, { state: "paid" }>;
  readonly preimage: string | null;

  constructor(invoice: DeclaredInvoice, status: Extract<PaymentStatus, { state: "paid" }>) {
    super("order_paid", "This order was already paid");
    this.name = "OrderPaidError";
    this.invoice = invoice;
    this.status = status;
    this.preimage = status.method === "lightning" ? status.preimage : null;
  }
}

/**
 * The order can only be paid on-chain (its amount is outside the Lightning address's bounds), and
 * no deposit address of the integration's lot could be leased: the lot is empty, or its addresses
 * are leased or paid. Retry later: the merchant's app fills the lot again whenever it is opened.
 */
export class OnchainUnavailableError extends SattlemeError {
  constructor() {
    super(
      "onchain_unavailable",
      "No deposit address of the integration's lot could be leased: try again later",
      true
    );
    this.name = "OnchainUnavailableError";
  }
}
