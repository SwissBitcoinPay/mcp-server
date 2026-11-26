import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import {
  NewerRecordError,
  newestRecord,
  openRecord,
  recordsThatOpen,
  type NewestRecord
} from "../../vendor/checkout-node/src/nostr/record.js";
import { RECORD_KIND } from "../../vendor/checkout-node/src/protocol.js";

import type { Call } from "../protocol/context.js";
import { AssistantError } from "../protocol/errors.js";
import type { AssistantKey } from "../protocol/key.js";
import type { AssistantKeys } from "../protocol/keys.js";

/*
 * The merchant's grant of the transactions' export (SPEC.md §20, the merchant's app's
 * src/lib/assistant/export-grant.ts): its decision, then the reading keys it gives, in parts,
 * signed by the team and sealed with the assistant's own keys. An assistant exports only with a
 * decision that allows it, newest on a majority's read, and every part of that decision. What it
 * gives are reading keys: never a key that signs, spends, or reads the wallet.
 */

const DECISION_TYPE = "assistant-export";
const KEYS_TYPE = "assistant-export-keys";
const VERSION = 1;

/** Parts of the keys at most (the app's MAX_GRANT_PARTS). */
export const MAX_GRANT_PARTS = 16;

const HEX_32 = /^[0-9a-f]{64}$/;
const MEMBER_ID = /^[0-9a-f]{32}$/;
const LANGUAGE = /^[a-z]{2}$/;
const LOCALE = /^[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8}){0,7}$/;
const TIME_ZONE = /^[A-Za-z0-9_+\-/]{1,64}$/;
/** A seat's name (the app's MEMBER_NAME_MAX_LENGTH): filled, 40 code units at most. */
const NAME_MAX_LENGTH = 40;

/** What reads the records of one author (hex). */
export type ReadKeys = { author: string; encryptionKey: string; addressKey: string };

/** The account's own records the export reads. */
export type GrantAccount = {
  /** The secret half of the registry's reading key: opens the inside of declarations and leases. */
  registryReader: string;
  invoices: ReadKeys;
  paymentRates: ReadKeys;
  walletSends: ReadKeys;
  archive: ReadKeys;
  legacyHistory: ReadKeys;
};

/** A device's or a seat's records: its sales and its payment links. */
export type GrantRecords = {
  sales: string;
  links: string;
  encryptionKey: string;
  addressKey: string;
};

export type GrantWitnesses = { author: string; addressKey: string };

type SeatBase = { id: string; since: number; removedAt: number | null };

/** Who took a payment, with the keys of what records it (« Par »). */
export type GrantSeat =
  | (SeatBase & { role: "owner"; name: null; records: GrantRecords })
  | (SeatBase & { role: "employee"; name: string; records: GrantRecords })
  | (SeatBase & { role: "assistant"; name: string; records: GrantRecords; invoices: ReadKeys })
  | (SeatBase & {
      role: "integration";
      name: string;
      channelKey: string;
      seen: GrantWitnesses;
      paid: GrantWitnesses;
    });

/** How the merchant's device writes its export. */
export type GrantFormat = { language: string; locale: string; timeZone: string | null };

/** What the grant gives, whole. */
export type ExportKeys = {
  account: GrantAccount;
  format: GrantFormat | null;
  seats: GrantSeat[];
  /** Removed seats the app left out (16 parts at most). */
  omitted: number;
};

type Decision = { allowed: boolean; updatedAt: number };

type Part =
  | {
      grantedAt: number;
      part: number;
      parts: number;
      account: GrantAccount | null;
      format: GrantFormat | null;
      omitted: number;
      seats: GrantSeat[];
    }
  | { grantedAt: null; part: number };

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isHex32 = (value: unknown): value is string =>
  typeof value === "string" && HEX_32.test(value);
const isUnixSeconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isName = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && value.length <= NAME_MAX_LENGTH;

function mac(key: Uint8Array, subject: string): string {
  return bytesToHex(hmac(sha256, key, utf8ToBytes(subject)));
}

/** The `d` tags of the decision and of part `part`. */
export function decisionAddress(keys: AssistantKeys): string {
  return mac(keys.exportGrant.addressKey, "decision");
}

export function partAddress(keys: AssistantKeys, part: number): string {
  return mac(keys.exportGrant.addressKey, `keys/${part}`);
}

function readKeysOf(value: unknown): ReadKeys | null {
  if (!isObject(value)) return null;
  const { author, encryptionKey, addressKey } = value;
  return isHex32(author) && isHex32(encryptionKey) && isHex32(addressKey)
    ? { author, encryptionKey, addressKey }
    : null;
}

function witnessesOf(value: unknown): GrantWitnesses | null {
  if (!isObject(value)) return null;
  const { author, addressKey } = value;
  return isHex32(author) && isHex32(addressKey) ? { author, addressKey } : null;
}

function recordsOf(value: unknown): GrantRecords | null {
  if (!isObject(value)) return null;
  const { sales, links, encryptionKey, addressKey } = value;
  return isHex32(sales) && isHex32(links) && isHex32(encryptionKey) && isHex32(addressKey)
    ? { sales, links, encryptionKey, addressKey }
    : null;
}

function accountOf(value: unknown): GrantAccount | null {
  if (!isObject(value) || !isHex32(value.registryReader)) return null;
  const invoices = readKeysOf(value.invoices);
  const paymentRates = readKeysOf(value.paymentRates);
  const walletSends = readKeysOf(value.walletSends);
  const archive = readKeysOf(value.archive);
  const legacyHistory = readKeysOf(value.legacyHistory);
  if (!invoices || !paymentRates || !walletSends || !archive || !legacyHistory) return null;
  return {
    registryReader: value.registryReader,
    invoices,
    paymentRates,
    walletSends,
    archive,
    legacyHistory
  };
}

/** A part's format, leniently: anything but a whole format is none. */
export function formatOf(value: unknown): GrantFormat | null {
  if (!isObject(value)) return null;
  const { language, locale, timeZone } = value;
  if (typeof language !== "string" || !LANGUAGE.test(language)) return null;
  if (typeof locale !== "string" || locale.length > 35 || !LOCALE.test(locale)) return null;
  if (!(timeZone === null || (typeof timeZone === "string" && TIME_ZONE.test(timeZone)))) {
    return null;
  }
  return { language, locale, timeZone: timeZone };
}

export function seatOf(value: unknown): GrantSeat | null {
  if (!isObject(value)) return null;
  const { role, id, name, since, removedAt } = value;
  if (typeof id !== "string" || !MEMBER_ID.test(id) || !isUnixSeconds(since)) return null;
  if (!(removedAt === null || isUnixSeconds(removedAt))) return null;
  const base: SeatBase = { id, since, removedAt };
  if (role === "owner") {
    const records = recordsOf(value.records);
    return name === null && removedAt === null && records
      ? { ...base, role, name: null, records }
      : null;
  }
  if (!isName(name)) return null;
  if (role === "employee") {
    const records = recordsOf(value.records);
    return records ? { ...base, role, name, records } : null;
  }
  if (role === "assistant") {
    const records = recordsOf(value.records);
    const invoices = readKeysOf(value.invoices);
    return records && invoices ? { ...base, role, name, records, invoices } : null;
  }
  if (role === "integration") {
    const seen = witnessesOf(value.seen);
    const paid = witnessesOf(value.paid);
    return isHex32(value.channelKey) && seen && paid
      ? { ...base, role, name, channelKey: value.channelKey, seen, paid }
      : null;
  }
  return null;
}

function decisionOf(value: unknown, createdAt: number): Decision | null {
  if (!isObject(value)) return null;
  if (typeof value.version === "number" && value.version > VERSION) throw new NewerRecordError();
  if (value.version !== VERSION || typeof value.allowed !== "boolean") return null;
  if (!isUnixSeconds(value.updatedAt) || value.updatedAt !== createdAt) return null;
  return { allowed: value.allowed, updatedAt: value.updatedAt };
}

export function partOf(value: unknown, part: number): Part | null {
  if (!isObject(value)) return null;
  if (typeof value.version === "number" && value.version > VERSION) throw new NewerRecordError();
  if (value.version !== VERSION || value.part !== part) return null;
  if (value.grantedAt === null) return { grantedAt: null, part };
  const { grantedAt, parts, seats } = value;
  if (!isUnixSeconds(grantedAt)) return null;
  if (typeof parts !== "number" || !Number.isSafeInteger(parts) || parts < 1) return null;
  if (parts > MAX_GRANT_PARTS || part >= parts || !Array.isArray(seats)) return null;
  const read: GrantSeat[] = [];
  for (const seat of seats as unknown[]) {
    const parsed = seatOf(seat);
    if (!parsed) return null;
    read.push(parsed);
  }
  let account: GrantAccount | null = null;
  let format: GrantFormat | null = null;
  let omitted = 0;
  if (part === 0) {
    account = accountOf(value.account);
    format = formatOf(value.format);
    if (
      !account ||
      typeof value.omitted !== "number" ||
      !Number.isSafeInteger(value.omitted) ||
      value.omitted < 0
    ) {
      return null;
    }
    omitted = value.omitted;
  } else if (
    value.account !== undefined ||
    value.omitted !== undefined ||
    value.format !== undefined
  ) {
    return null;
  }
  return { grantedAt, part, parts, account, format, omitted, seats: read };
}

function newerThanRead<T>(found: NewestRecord<T>): boolean {
  return (
    found.newestUnreadable !== null &&
    found.newestUnreadable > (found.newest?.event.created_at ?? -1)
  );
}

/**
 * Whether the merchant allows this assistant to export the transactions now: its decision only
 * (the newest on a majority of `relays`), not the keys it gives, for the tools the server lists
 * (SPEC.md §20). Throws AssistantError `network` when fewer than a majority answered, `newer` when
 * a newer app wrote it.
 */
export async function readExportDecision(
  call: Call,
  access: AssistantKey,
  keys: AssistantKeys,
  relays: readonly string[]
): Promise<boolean> {
  const { encryptionKey } = keys.exportGrant;
  const team = access.teamPublicKey;
  const address = decisionAddress(keys);
  const { answers, answered } = await call.pool.queryRelays(
    relays,
    { kinds: [RECORD_KIND], authors: [team], "#d": [address] },
    keys.member.nostr.secretKey,
    {
      paged: false,
      keep: recordsThatOpen((_, author) => (author === team ? encryptionKey : null))
    }
  );
  if (!answered) {
    throw new AssistantError("network", "Fewer than a majority of the merchant's relays answered");
  }
  const decision = newestRecord(answers, (value) =>
    openRecord(value, {
      type: DECISION_TYPE,
      encryptionKey,
      address,
      author: team,
      parse: (payload, event) => decisionOf(payload, event.created_at)
    })
  );
  if (newerThanRead(decision)) {
    throw new AssistantError("newer", "The export grant has a newer format: update this server");
  }
  return decision.newest?.value.allowed === true;
}

/**
 * The grant on the merchant's `relays`, read as the merchant's app writes it. Throws AssistantError
 * `network` when fewer than a majority answered, `newer` when a newer app wrote it, and
 * `export_not_allowed` when the merchant did not allow it (or withdrew it): never an export on a
 * guess.
 */
export async function readExportGrant(
  call: Call,
  access: AssistantKey,
  keys: AssistantKeys,
  relays: readonly string[]
): Promise<ExportKeys> {
  const { encryptionKey } = keys.exportGrant;
  const team = access.teamPublicKey;
  const addresses = [
    decisionAddress(keys),
    ...Array.from({ length: MAX_GRANT_PARTS }, (_, part) => partAddress(keys, part))
  ];
  const { answers, answered } = await call.pool.queryRelays(
    relays,
    { kinds: [RECORD_KIND], authors: [team], "#d": addresses },
    keys.member.nostr.secretKey,
    {
      paged: false,
      keep: recordsThatOpen((_, author) => (author === team ? encryptionKey : null))
    }
  );
  if (!answered) {
    throw new AssistantError("network", "Fewer than a majority of the merchant's relays answered");
  }
  const decision = newestRecord(answers, (value) =>
    openRecord(value, {
      type: DECISION_TYPE,
      encryptionKey,
      address: addresses[0]!,
      author: team,
      parse: (payload, event) => decisionOf(payload, event.created_at)
    })
  );
  if (newerThanRead(decision)) {
    throw new AssistantError("newer", "The export grant has a newer format: update this server");
  }
  const allowed = decision.newest?.value;
  if (!allowed?.allowed) {
    throw new AssistantError(
      "export_not_allowed",
      "The merchant has not allowed this assistant to export the transactions"
    );
  }
  const parts = Array.from({ length: MAX_GRANT_PARTS }, (_, part) =>
    newestRecord(answers, (value) =>
      openRecord(value, {
        type: KEYS_TYPE,
        encryptionKey,
        address: addresses[part + 1]!,
        author: team,
        parse: (payload) => partOf(payload, part)
      })
    )
  );
  const first = parts[0]!.newest?.value;
  const count = first && first.grantedAt === allowed.updatedAt ? first.parts : 0;
  const seats: GrantSeat[] = [];
  for (let part = 0; part < count; part += 1) {
    const found = parts[part]!;
    if (newerThanRead(found)) {
      throw new AssistantError("newer", "The export grant has a newer format: update this server");
    }
    const value = found.newest?.value;
    if (!value || value.grantedAt !== allowed.updatedAt || value.parts !== count) {
      throw new AssistantError(
        "export_unread",
        "The keys of the export grant are not all on the relays yet: try again later"
      );
    }
    seats.push(...value.seats);
  }
  if (!first || first.grantedAt !== allowed.updatedAt) {
    throw new AssistantError(
      "export_unread",
      "The keys of the export grant are not on the relays yet: try again later"
    );
  }
  return { account: first.account!, format: first.format, seats, omitted: first.omitted };
}
