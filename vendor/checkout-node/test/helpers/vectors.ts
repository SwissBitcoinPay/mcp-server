import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The package's root. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The pinned copy of the specification (spec/, PIN.json): its vectors, never edited here
 * (test/spec-pin.test.ts).
 */
export const SPEC_DIR = join(ROOT, "spec");

/**
 * Where vectors are written when they are made on purpose (UPDATE_VECTORS=1): a clone of
 * sattleme/checkout-spec, never the pinned copy. The new version is then published there
 * by pull request, and taken back here with `node scripts/spec.mjs import <clone>`.
 */
export function vectorsOut(): string | null {
  if (!process.env.UPDATE_VECTORS) return null;
  const out = process.env.VECTORS_OUT;
  if (!out) throw new Error("UPDATE_VECTORS needs VECTORS_OUT: a clone of checkout-spec");
  return out;
}

/** A file of the pinned copy of the specification, as JSON (`path` relative to spec/). */
export function readSpec<T>(path: string): T {
  return JSON.parse(readFileSync(join(SPEC_DIR, path), "utf8")) as T;
}

type Event = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

/** vectors/app/app.json: made by the merchant's app. */
export type AppVectors = {
  secretKey: string;
  parsed: { team: string; integrationKey: string; relays: string[] };
  derived: { channelAddress: string; channelEncryptionKey: string; takerKey: string };
  channel: {
    event: Event;
    value: { t: string; v: Record<string, unknown> & { relays: string[] } };
  };
  declaration: {
    ref: string;
    invoice: string;
    paymentHash: string;
    verifyUrl: string;
    fiat: { minor: number; digits: number; currency: string };
    note: string;
    saleKey: string;
    saleSecret: string;
    saleAuthor: string;
    taker: string;
    address: string;
    outerKey: string;
    innerConversationKey: string;
    outsideBytes: number;
    event: Event;
  };
  realInvoice: {
    invoice: string;
    amountMsat: string;
    timestamp: number;
    expirySeconds: number;
    paymentHash: string;
    descriptionHash: string;
    preimage: string;
  };
};

export const appVectors = readSpec<AppVectors>("vectors/app/app.json");
