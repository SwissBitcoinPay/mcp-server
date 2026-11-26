import { conversationKey, nip44Decrypt } from "../../src/nostr/nip44.js";
import { outerKey } from "../../src/derive.js";
import type { NostrEvent } from "../../src/nostr/event.js";

/** A declaration, opened as the merchant's app does: with the registry key and the reading key. */
export function openAsOwner(
  event: NostrEvent,
  registryKey: Uint8Array,
  readerSecret: Uint8Array
): Record<string, unknown> {
  const address = event.tags.find(([name]) => name === "d")![1]!;
  const outside = JSON.parse(
    nip44Decrypt(event.content, outerKey(registryKey, address, event.pubkey))
  ) as { t: string; v: { sealed: string } };
  if (outside.t !== "registry-declaration") throw new Error("Not a declaration");
  return JSON.parse(
    nip44Decrypt(outside.v.sealed, conversationKey(readerSecret, event.pubkey))
  ) as Record<string, unknown>;
}
