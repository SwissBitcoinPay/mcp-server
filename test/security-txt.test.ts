// The hosted server's /.well-known/security.txt (RFC 9116, SECURITY.md), served by Caddy from the
// release. Its Expires must be renewed in time: this test fails 30 days before it expires.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const text = readFileSync(".well-known/security.txt", "utf8");
const day = 24 * 3600 * 1000;
const fields = text
  .split("\n")
  .filter((line) => line !== "" && !line.startsWith("#"))
  .map((line) => line.split(": "));

// The fingerprint of an armored OpenPGP v4 public key (RFC 4880, 12.2): SHA-1 over 0x99, the
// length and the body of its first packet, which must be a public key (tag 6), never a secret one.
function fingerprint(armored: string): string {
  const base64 = armored
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("-----") && !line.startsWith("="))
    .join("");
  const key = Buffer.from(base64, "base64");
  if (key[0] !== 0xc6 || (key[1] ?? 255) >= 192) throw new Error("not a public key packet first");
  const body = key.subarray(2, 2 + (key[1] ?? 0));
  const length = Buffer.from([body.length >> 8, body.length & 255]);
  return createHash("sha1")
    .update(Buffer.from([0x99]))
    .update(length)
    .update(body)
    .digest("hex");
}

describe(".well-known/security.txt", () => {
  it("has only fields, each with a value", () => {
    for (const field of fields) expect(field.length, field.join(": ")).toBe(2);
  });

  it("names the security contact", () => {
    expect(fields).toContainEqual(["Contact", "mailto:security@sattle.me"]);
  });

  it("expires once, in 30 days to a year (RFC 9116, 2.5.5)", () => {
    const expires = fields.filter(([name]) => name === "Expires").map(([, value]) => value ?? "");
    expect(expires).toHaveLength(1);
    const date = Date.parse(expires[0] ?? "");
    expect(date, `Expires ${expires[0]}: renew it a year ahead`).toBeGreaterThan(
      Date.now() + 30 * day
    );
    expect(date, `Expires ${expires[0]} is more than a year away`).toBeLessThan(
      Date.now() + 366 * day
    );
  });

  it("names the fingerprint of the OpenPGP key served beside it", () => {
    const key = readFileSync(".well-known/pgp-key.txt", "utf8");
    expect(key).toContain("-----BEGIN PGP PUBLIC KEY BLOCK-----");
    expect(fields).toContainEqual(["Encryption", `openpgp4fpr:${fingerprint(key)}`]);
  });
});
