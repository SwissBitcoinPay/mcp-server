import { describe, expect, it } from "vitest";

import { Sealer } from "../src/hosted/seal.js";

/* The hosted server's sealed values (src/hosted/seal.ts). */

const sealer = new Sealer(new Uint8Array(32).fill(7));
const NOW = 1_793_701_200;

describe("a sealed value", () => {
  it("opens for its purpose until it expires", () => {
    const text = sealer.seal("access", { key: "sattleme_ak_x" }, NOW + 60);
    expect(sealer.open("access", text, NOW)).toEqual({ key: "sattleme_ak_x" });
    expect(sealer.open("access", text, NOW + 60)).toBeNull();
    expect(text).not.toContain("sattleme_ak_x");
  });

  it("never opens as another purpose, under another secret, nor altered", () => {
    const text = sealer.seal("code", { a: 1 }, NOW + 60);
    expect(sealer.open("access", text, NOW)).toBeNull();
    expect(new Sealer(new Uint8Array(32).fill(8)).open("code", text, NOW)).toBeNull();
    const bytes = Buffer.from(text, "base64url");
    bytes[20] = bytes[20]! ^ 1;
    expect(sealer.open("code", bytes.toString("base64url"), NOW)).toBeNull();
    for (const other of ["", "x", 42, null, "A".repeat(9000)])
      expect(sealer.open("code", other, NOW)).toBeNull();
  });

  it("needs a secret of 32 bytes", () => {
    expect(() => new Sealer(new Uint8Array(31))).toThrow();
  });
});
