/**
 * Where random bytes come from: the NIP-44 nonces, the BIP-340 auxiliary data of signatures, the
 * keys of a single relay read and the subscription ids. `crypto.getRandomValues` (Web Crypto,
 * global in Node 22, Bun and Deno), never `Math.random`. Replaceable for reproducible tests only.
 */
export type RandomBytes = (length: number) => Uint8Array;

export const secureRandomBytes: RandomBytes = (length) => {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};
