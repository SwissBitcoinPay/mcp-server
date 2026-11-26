import { bytesToHex } from "@noble/hashes/utils.js";

import { deriveKey } from "../../../vendor/checkout-node/src/derive.js";
import type { NostrEvent } from "../../../vendor/checkout-node/src/nostr/event.js";
import {
  NewerRecordError,
  newestRecord,
  openRecord,
  recordsThatOpen
} from "../../../vendor/checkout-node/src/nostr/record.js";
import type { RelayPool } from "../../../vendor/checkout-node/src/nostr/relay.js";
import { RECORD_KIND } from "../../../vendor/checkout-node/src/protocol.js";

import {
  LINK_TYPE,
  SALE_ACCEPTANCE_SALT,
  SALE_ACCEPTANCE_TYPE,
  SALE_ACCEPTANCE_VERSION
} from "../constants.js";
import {
  linkAddress,
  ownerFinalAddress,
  parseLinkPayload,
  saleOwnerKey,
  type LinkSale,
  type SaleFinal
} from "../link.js";
import { isObject } from "../text.js";

/*
 * A sale's link read back (SPEC.md §15): its published payload, its final version (the link's own,
 * or the merchant's, signed by the sale's owner key), and the merchant's acceptance of the sale paid
 * short. Each read authenticates with a key of that read alone (`authKey`): these records are the
 * sale's, never the assistant's.
 */

export type LinkRead =
  | { ok: true; sale: LinkSale; final: SaleFinal | null }
  /** `relays`: fewer than a majority answered; `missing`: none holds a valid copy. */
  | { ok: false; reason: "relays" | "missing" };

const MAX_SATS = 2_100_000_000_000_000n;
const SATS = /^[1-9][0-9]{0,15}$/;

function earlier(a: NostrEvent, b: NostrEvent): boolean {
  return a.created_at < b.created_at || (a.created_at === b.created_at && a.id < b.id);
}

/** A final version read, and whether it is the merchant's settlement of a sale that received something. */
type FoundFinal = { final: SaleFinal; event: NostrEvent; settles: boolean };

/**
 * Whether `a` counts over `b` (SPEC.md §15): the merchant's final version that received something
 * (paid or underpaid) before any other, then the first made. The merchant's app settles a sale its
 * owner canceled and that was paid all the same (a Lightning invoice kept in a payer's wallet, the
 * on-chain address), over the cancellation. The merchant's only: the link's own key never undoes
 * it.
 */
function counts(a: FoundFinal, b: FoundFinal): boolean {
  return a.settles !== b.settles ? a.settles : earlier(a.event, b.event);
}

/**
 * The link of `author` and `saleKey` on `relays`: a valid copy of its payload, and its final
 * version when there is one (of several, the one that counts: `counts`). `ok: false` when fewer
 * than a majority answered, or none holds a valid copy.
 */
export async function readLink(
  pool: RelayPool,
  relays: readonly string[],
  author: string,
  saleKey: Uint8Array,
  authKey: Uint8Array,
  { pointOfSale = false }: { pointOfSale?: boolean } = {}
): Promise<LinkRead> {
  const address = linkAddress(saleKey);
  const own = await pool.queryRelays(
    relays,
    { kinds: [RECORD_KIND], authors: [author], "#d": [address] },
    authKey,
    {
      paged: false,
      keep: recordsThatOpen((d, by) => (by === author && d === address ? saleKey : null))
    }
  );
  if (!own.answered) return { ok: false, reason: "relays" };
  let sale: LinkSale | null = null;
  let final: FoundFinal | null = null;
  const take = (copy: { value: LinkSale; event: NostrEvent }, merchant: boolean) => {
    sale ??= copy.value;
    if (!copy.value.final) return;
    const found = {
      final: copy.value.final,
      event: copy.event,
      settles: merchant && copy.value.final.received > 0n
    };
    if (!final || counts(found, final)) final = found;
  };
  for (const events of own.answers.values()) {
    for (const value of events) {
      const copy = openRecord(value, {
        type: LINK_TYPE,
        encryptionKey: saleKey,
        address,
        author,
        parse: (payload) => {
          const parsed = parseLinkPayload(payload, { pointOfSale });
          return parsed && (parsed.final === null || parsed.final.link === author) ? parsed : null;
        }
      });
      if (copy?.status === "ok") take(copy, false);
    }
  }
  if (sale === null) return { ok: false, reason: "missing" };
  const owner = (sale as LinkSale).owner;
  let signer: string;
  try {
    signer = saleOwnerKey(owner, saleKey);
  } catch {
    return { ok: true, sale, final: final === null ? null : (final as { final: SaleFinal }).final };
  }
  const ownerAddress = ownerFinalAddress(author);
  const merchant = await pool.queryRelays(
    relays,
    { kinds: [RECORD_KIND], authors: [signer], "#d": [ownerAddress] },
    authKey,
    {
      paged: false,
      keep: recordsThatOpen((d, by) => (by === signer && d === ownerAddress ? saleKey : null))
    }
  );
  // The merchant's final version not read: its own may be missing, never the link's own.
  if (!merchant.answered && final === null) return { ok: false, reason: "relays" };
  for (const events of merchant.answers.values()) {
    for (const value of events) {
      const copy = openRecord(value, {
        type: LINK_TYPE,
        encryptionKey: saleKey,
        address: ownerAddress,
        author: signer,
        parse: (payload) => {
          const parsed = parseLinkPayload(payload, { pointOfSale });
          return parsed?.final && parsed.final.link === author && parsed.owner === owner
            ? parsed
            : null;
        }
      });
      if (copy?.status === "ok") take(copy, true);
    }
  }
  return { ok: true, sale, final: final === null ? null : (final as { final: SaleFinal }).final };
}

/** The `d` tag and key of the acceptance of the sale whose key is `saleKey`. */
export function acceptanceKeys(saleKey: Uint8Array): {
  address: string;
  encryptionKey: Uint8Array;
} {
  return {
    address: bytesToHex(deriveKey(saleKey, SALE_ACCEPTANCE_SALT, "address/v1")),
    encryptionKey: deriveKey(saleKey, SALE_ACCEPTANCE_SALT, "encryption-key/v1")
  };
}

export function parseAcceptance(value: unknown): { received: bigint; due: bigint } | null {
  if (!isObject(value)) return null;
  if (typeof value.version === "number" && value.version > SALE_ACCEPTANCE_VERSION) {
    throw new NewerRecordError();
  }
  if (value.version !== SALE_ACCEPTANCE_VERSION) return null;
  const { received, due } = value;
  if (typeof received !== "string" || !SATS.test(received)) return null;
  if (typeof due !== "string" || !SATS.test(due)) return null;
  const [r, d] = [BigInt(received), BigInt(due)];
  return r < d && d <= MAX_SATS ? { received: r, due: d } : null;
}

/**
 * The merchant's acceptance of the sale paid short (what it had received and was due then, and
 * when: its `created_at`); null when there is none (or only of a newer format), undefined when
 * fewer than a majority answered.
 */
export async function readAcceptance(
  pool: RelayPool,
  relays: readonly string[],
  owner: string,
  saleKey: Uint8Array,
  authKey: Uint8Array
): Promise<{ received: bigint; due: bigint; at: number } | null | undefined> {
  let signer: string;
  try {
    signer = saleOwnerKey(owner, saleKey);
  } catch {
    return null;
  }
  const { address, encryptionKey } = acceptanceKeys(saleKey);
  const { answers, answered } = await pool.queryRelays(
    relays,
    { kinds: [RECORD_KIND], authors: [signer], "#d": [address] },
    authKey,
    {
      paged: false,
      keep: recordsThatOpen((d, by) => (by === signer && d === address ? encryptionKey : null))
    }
  );
  if (!answered) return undefined;
  const { newest } = newestRecord(answers, (value) =>
    openRecord(value, {
      type: SALE_ACCEPTANCE_TYPE,
      encryptionKey,
      address,
      author: signer,
      parse: parseAcceptance
    })
  );
  return newest
    ? { received: newest.value.received, due: newest.value.due, at: newest.event.created_at }
    : null;
}
