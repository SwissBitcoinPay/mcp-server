/*
 * What an assistant's call can end with, besides its result (SPEC.md §13 to §15). Each has a code
 * the MCP tools pass on to the model, and a message for a person; never a key, an amount of
 * another sale, nor a client's data.
 */

export type ErrorCode =
  /** Fewer than a majority of the relays answered or took a record: nothing was decided. */
  | "network"
  /** The merchant removed the assistant in the app. */
  | "revoked"
  /** A majority of the key's relays answered without the assistant's channel. */
  | "not_found"
  /** A record of a newer format than this server reads: update it. */
  | "newer"
  /** The merchant's app gives no web app for payment links (a version without one). */
  | "no_web_app"
  /** The account's currency is not one this server knows. */
  | "unsupported_currency"
  /** What was asked does not make an invoice: `details` says what. */
  | "invalid_invoice"
  /** Paid over Lightning only, the total is above what the Lightning address takes. */
  | "above_lightning"
  /** The Lightning address or the price of the hour could not be read. */
  | "unverified"
  /** No number could be taken (fewer than a majority, a newer writer). */
  | "number"
  /** No such invoice of this assistant. */
  | "unknown_invoice"
  /** The merchant created this assistant without invoices (SPEC.md §5): it makes and reads none. */
  | "invoicing_not_allowed"
  /** The merchant has not allowed this assistant to export the transactions (SPEC.md §20). */
  | "export_not_allowed"
  /** The grant's keys are not all readable yet (written after its decision): try again. */
  | "export_unread"
  /** What was asked does not make an export (its period, language, locale…): `details` says what. */
  | "invalid_export";

export class AssistantError extends Error {
  readonly code: ErrorCode;
  /** What is off, for `invalid_invoice`; the largest sats, for `above_lightning`. */
  readonly details: readonly string[];

  constructor(code: ErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = "AssistantError";
    this.code = code;
    this.details = details;
  }
}
