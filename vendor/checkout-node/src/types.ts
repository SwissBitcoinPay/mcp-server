/*
 * What the package gives and takes (SPEC.md, "Data model"). Everything an integrator stores is
 * JSON as is: every amount is a string of digits (sats, minor units), never a float; every date is
 * an integer of Unix seconds; an absent value is null.
 */

/** A price in a currency: `minor` units with `digits` decimals ("2450", 2, "CHF" is 24.50 CHF). */
export type Fiat = {
  /** The price as written, with the currency's decimals: "24.50". */
  amount: string;
  /** ISO 4217, upper case. */
  currency: string;
  /** The price in the currency's minor units, a string of digits: "2450". */
  minor: string;
  /** The currency's decimals (ISO 4217 minor units): 2. */
  digits: number;
};

/** The rate an amount in a currency was converted at: for the audit, and to answer a customer. */
export type RateInfo = {
  /** The source: "coingecko", "mempool", "opennode", "coinbase", "kraken" or "custom". */
  source: string;
  currency: string;
  /** The price of one bitcoin in `currency`, as an exact decimal string. */
  price: string;
  /** Unix seconds: when the package read it. */
  fetchedAt: number;
  /** Unix seconds: when the source says the price was set, null when it does not say. */
  time: number | null;
};

/**
 * The invoice of an order (createInvoice): store it with the order. The shop's page needs
 * `paymentUri` (or `bolt11` and `onchainAddress`) and `expiresAt` only. An order is paid with a
 * Lightning invoice, a deposit address, or both: at least one of `bolt11` and `onchainAddress` is
 * not null.
 */
export type Invoice = {
  /** The order's reference. */
  ref: string;
  /** The BOLT11 invoice: what the customer's wallet pays; null for an order paid on-chain only. */
  bolt11: string | null;
  /** Hex: its payment hash; null without `bolt11`. */
  paymentHash: string | null;
  /** Its LUD-21 verify URL; null without `bolt11`. */
  verifyUrl: string | null;
  /** The deposit address of the merchant's wallet the order leased (`bc1p…`), null without one. */
  onchainAddress: string | null;
  /**
   * What the shop's page shows as one QR code: `bitcoin:<address>?amount=…&lightning=…` with an
   * address, else `lightning:<bolt11>`.
   */
  paymentUri: string;
  /** The amount, in sats (a string of digits): the invoice's, and what the address must receive. */
  sats: string;
  /** The order's price when it was given in a currency, else null. */
  fiat: Fiat | null;
  /** The rate `fiat` was converted at, else null. */
  rate: RateInfo | null;
  /** What the merchant's app shows: the note, else the reference. */
  note: string;
  /** Unix seconds: the invoice's date (without `bolt11`, when the address was leased). */
  createdAt: number;
  /** Unix seconds: when it can no longer be paid. */
  expiresAt: number;
  /**
   * The URL of its checkout link, where the shop sends its customer to pay (the order asked for
   * one: `checkout: true`), else null.
   */
  checkoutUrl: string | null;
  /** Where the checkout link sends the customer once the invoice is paid, else null. */
  redirectUrl: string | null;
};

/**
 * What a payment check needs of an invoice: an Invoice or a DeclaredInvoice will do. `ref` is
 * needed with an address: the witnesses of the payment are its order's.
 */
export type InvoiceToCheck = Pick<
  Invoice,
  "bolt11" | "paymentHash" | "verifyUrl" | "sats" | "expiresAt"
> & {
  ref?: string;
  /** Absent: null. */
  onchainAddress?: string | null;
};

/**
 * An invoice declared for an order, as the merchant's registry holds it (findInvoices,
 * InvoicePendingError, OrderPaidError): the fields of an Invoice but `rate`, `checkoutUrl` and
 * `redirectUrl`, which only the shop keeps.
 */
export type DeclaredInvoice = Omit<Invoice, "rate" | "checkoutUrl" | "redirectUrl"> & {
  /** Unix seconds: when it was declared (without `bolt11`, when its address was leased). */
  declaredAt: number;
};

/**
 * What is left to pay of an invoice underpaid on-chain (PaymentStatus `open`): `sats` (a string of
 * digits), a Lightning invoice of exactly that, declared for the order (null while there is none:
 * asked again at the next check, or outside the Lightning address's bounds), and what to show as
 * one QR code: `bitcoin:<address>?amount=…&lightning=…` from 1 000 sats (on-chain to the same
 * address too), `lightning:<bolt11>` below; null with neither.
 */
export type Rest = { sats: string; bolt11: string | null; paymentUri: string | null };

/**
 * Where the payment of an invoice is. `received` is what the order received in time: on-chain to
 * its address, and by the Lightning invoices of the rest of an on-chain underpayment. Below the
 * amount in `unconfirmed` and `paid` (on-chain or mixed) when the merchant's tolerance of on-chain
 * underpayments, or the merchant's acceptance of what came (in its app), accepted it: the order is
 * paid all the same.
 */
export type PaymentStatus =
  /**
   * Not paid (yet): it may still be, until `expiresAt`, and is reported up to 120 s later.
   * `received` above 0: an on-chain underpayment, whose `rest` is still payable until `expiresAt`
   * (null otherwise).
   */
  | { state: "open"; expiresAt: number; received: string; rest: Rest | null }
  /**
   * Enough was received in time (the amount, or less within the merchant's tolerance or down to
   * what the merchant accepted), on-chain by the transactions `txids` (and by invoices of the
   * rest), not deep enough yet (3 confirmations): not paid yet, it may still fail (a transaction
   * replaced or dropped).
   */
  | { state: "unconfirmed"; received: string; confirmations: number; txids: string[] }
  /** Paid in Lightning: `preimage` (hex) is the proof of payment, to keep with the order. */
  | { state: "paid"; method: "lightning"; preimage: string }
  /**
   * Paid on-chain by the transactions `txids` (3 confirmations on the explorer read: mempool.space,
   * or the merchant's Bitcoin node).
   */
  | { state: "paid"; method: "onchain"; received: string; txids: string[] }
  /**
   * Paid on-chain by `txids` (3 confirmations on the explorer read; none when the invoices of the
   * rest alone pay it) and in Lightning by invoices of the rest of that underpayment, whose
   * `preimages` (hex) are the proofs of those payments, to keep with the order.
   */
  | { state: "paid"; method: "mixed"; received: string; txids: string[]; preimages: string[] }
  /**
   * Never paid, for good: the order may get a new invoice. `received` above 0: the merchant
   * received that much, less than the amount (settle it with the customer). One exception
   * (SPEC.md §3): an order the merchant accepted in its app may read `expired` when a relay that
   * holds that acceptance fails, then `paid` at a later check.
   */
  | { state: "expired"; received: string };

/** The merchant, as the integration's channel, Lightning address and lot give it. */
export type Merchant = {
  businessName: string;
  /** Smallest invoice the Lightning address makes, in sats (a string of digits). */
  minSats: string;
  /** Largest invoice the Lightning address makes, in sats (a string of digits). */
  maxSats: string;
  /** The deposit addresses of the integration's lot, leased or not: 0 takes no on-chain payment. */
  onchainAddresses: number;
};

/** Where warnings go (a format newer than this package reads…). `console` by default. */
export type Logger = { warn: (message: string) => void };
