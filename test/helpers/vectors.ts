import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { NostrEvent } from "../../vendor/checkout-node/src/nostr/event.js";

/*
 * The app's vectors (vectors/app/assistant.json, SPEC.md §19): made by the merchant's app from the
 * BIP-39 test mnemonic, never a real wallet. Read as they are, never edited here.
 */

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

type Record<T> = { event: NostrEvent; value: T };

export type AssistantVectors = {
  secretKey: string;
  parsed: { team: string; assistantKey: string; relays: string[] };
  derived: {
    channelAddress: string;
    channelEncryptionKey: string;
    memberPublicKey: string;
    recordsEncryptionKey: string;
    recordsAddressKey: string;
    linksPublicKey: string;
    takerKey: string;
    invoicesAuthor: string;
    invoicesEncryptionKey: string;
    invoicesAddressKey: string;
    lotAddress: string;
    usedAddress: string;
  };
  channel: Record<{
    profile: { businessName: string; lightningAddress: string; currency: string; onchain: boolean };
    registryKey: string;
    registryReader: string;
    linkOwner: string;
    relays: string[];
    invoicing: { counterKey: string; counterWriters: string[]; linkOrigin: string };
    updatedAt: number;
  }>;
  lot: Record<{ addresses: string[]; tags: string[]; updatedAt: number }>;
  used: Record<{ used: string[]; lotAt: number; updatedAt: number }>;
  /** An assistant's lot of version 2 (100 addresses) and its used record, beyond 20. */
  lotV2: Record<{ version: number; addresses: string[]; tags: string[]; updatedAt: number }>;
  usedV2: Record<{ version: number; used: string[]; lotAt: number; updatedAt: number }>;
  counter: {
    counterKey: string;
    encryptionKey: string;
    address: string;
    ownerCopy: Record<{ version: number; year: number; last: number }>;
    next: { year: number; sequence: number };
  };
  invoice: Record<unknown> & {
    address: string;
    totals: unknown;
  };
  link: {
    saleKey: string;
    saleAuthor: string;
    takerTag: string;
    address: string;
    linkSecretKey: string;
    author: string;
    url: string;
    event: NostrEvent;
    payload: unknown;
  };
  linkRecord: Record<unknown> & { address: string };
};

export const vectors = JSON.parse(
  readFileSync(join(ROOT, "vectors/app/assistant.json"), "utf8")
) as AssistantVectors;

/**
 * The app's vectors of an assistant created without invoices (vectors/app/assistant-no-invoicing.json,
 * SPEC.md §5, §19): the channel the owner wrote for the assistant of assistant.json, version 2.
 */
export const NO_INVOICING_PATH = join(ROOT, "vectors/app/assistant-no-invoicing.json");

export const noInvoicingVectors = JSON.parse(readFileSync(NO_INVOICING_PATH, "utf8")) as {
  channel: Record<{ version: number; updatedAt: number; relays: string[] }>;
};
