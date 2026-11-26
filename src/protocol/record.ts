import { utf8ToBytes } from "@noble/hashes/utils.js";

import { signEvent, type NostrEvent } from "../../vendor/checkout-node/src/nostr/event.js";
import { nip44Encrypt } from "../../vendor/checkout-node/src/nostr/nip44.js";
import { RECORD_KIND } from "../../vendor/checkout-node/src/protocol.js";
import { secureRandomBytes, type RandomBytes } from "../../vendor/checkout-node/src/random.js";

/*
 * Sealed records (spec/SPEC.md §12) padded to a multiple of `block` bytes: the integrations' code
 * pads to 256 only, and an invoice's record is padded to 1024 (SPEC.md §2), as the merchant's app
 * writes it. The same envelope otherwise: `{"t": <type>, "v": <value>}`, spaces after the JSON,
 * NIP-44 v2, kind 30078, the `d` tag first.
 */
export function sealRecordIn({
  type,
  value,
  signer,
  encryptionKey,
  address,
  createdAt,
  block,
  random = secureRandomBytes
}: {
  type: string;
  value: unknown;
  signer: Uint8Array;
  encryptionKey: Uint8Array;
  address: string;
  createdAt: number;
  block: number;
  random?: RandomBytes;
}): NostrEvent {
  const text = JSON.stringify({ t: type, v: value });
  const length = utf8ToBytes(text).length;
  const padded = text + " ".repeat(Math.ceil(length / block) * block - length);
  return signEvent(
    {
      kind: RECORD_KIND,
      created_at: createdAt,
      tags: [["d", address]],
      content: nip44Encrypt(padded, encryptionKey, random)
    },
    signer,
    random
  );
}
