import { describe, expect, it } from "vitest";

import { verdictOf, type SaleProofs } from "../src/protocol/follow/verdict.js";
import { satsAt } from "../src/protocol/points.js";

/*
 * The status of a sale from its proofs (SPEC.md §15), as the merchant's app settles it
 * (useSale.ts): pure cases.
 */

/** 2026-11-03 09:00 UTC. */
const hour = 1_793_696_400;
const fiat = { minor: 390_410, digits: 2 };
// 3904.10 CHF: 4 880 125 sats at 80 000, 4 436 478 at 88 000.
const due80 = satsAt(fiat.minor, fiat.digits, 80_000);
const due88 = satsAt(fiat.minor, fiat.digits, 88_000);

function proofs(extra: Partial<SaleProofs> = {}): SaleProofs {
  return {
    now: hour + 1800,
    endsAt: hour + 30 * 86_400,
    fiat,
    tolerance: 0,
    lightning: [],
    openInvoiceEnds: [],
    onchain: [],
    points: new Map([
      [hour - 3600, 80_000],
      [hour, 80_000]
    ]),
    acceptance: null,
    ...extra
  };
}

const ln = (sats: bigint, at = hour) => ({
  hour: at,
  timestamp: at + 400,
  sats,
  paymentHash: "aa",
  preimage: "bb"
});
const tx = (sats: bigint, confirmations: number, atSeconds = hour + 600) => ({
  txid: "cc",
  sats,
  confirmations,
  at: atSeconds * 1000
});

describe("the verdict", () => {
  it("is the amount at the point of the hour, rounded up", () => {
    expect(due80).toBe(4_880_125n);
    expect(due88).toBe(4_436_478n);
  });

  it("is open while nothing was received", () => {
    expect(verdictOf(proofs())).toEqual({ state: "open" });
  });

  it("is paid once Lightning brought the amount due at the hour", () => {
    expect(verdictOf(proofs({ lightning: [ln(due80)] }))).toEqual({
      state: "paid",
      method: "lightning",
      received: due80,
      due: due80,
      accepted: false
    });
  });

  it("is paid at a lower amount due of a later hour of the sale", () => {
    const points = new Map([
      [hour - 3600, 80_000],
      [hour, 88_000]
    ]);
    const paid = verdictOf(proofs({ lightning: [ln(due88, hour - 3600)], points }));
    expect(paid).toMatchObject({ state: "paid", due: due88 });
  });

  it("is underpaid, with the rest at the present hour, for less", () => {
    expect(verdictOf(proofs({ lightning: [ln(1_000_000n)] }))).toEqual({
      state: "underpaid",
      received: 1_000_000n,
      rest: due80 - 1_000_000n,
      due: null,
      ended: false
    });
  });

  it("is underpaid for good past the end, once no invoice may still be told paid", () => {
    const ended = { now: hour + 7200, endsAt: hour + 3600 };
    expect(
      verdictOf(proofs({ ...ended, lightning: [ln(1_000_000n)], openInvoiceEnds: [hour + 3500] }))
    ).toEqual({
      state: "checking",
      reason: "late_report"
    });
    expect(verdictOf(proofs({ ...ended, lightning: [ln(1_000_000n)] }))).toEqual({
      state: "underpaid",
      received: 1_000_000n,
      rest: null,
      due: due80,
      ended: true
    });
  });

  it("is paid at what was received once the merchant accepted it", () => {
    const accepted = verdictOf(
      proofs({ onchain: [tx(4_000_000n, 3)], acceptance: { received: 4_000_000n } })
    );
    expect(accepted).toEqual({
      state: "paid",
      method: "onchain",
      received: 4_000_000n,
      due: null,
      accepted: true
    });
    // A replacement that pays less than what was accepted: underpaid again.
    expect(
      verdictOf(proofs({ onchain: [tx(3_000_000n, 3)], acceptance: { received: 4_000_000n } }))
        .state
    ).toBe("underpaid");
  });

  it("confirms an on-chain payment 3 blocks deep", () => {
    expect(verdictOf(proofs({ onchain: [tx(due80, 1)] }))).toEqual({
      state: "confirming",
      method: "onchain",
      received: due80,
      confirmations: 1
    });
    expect(verdictOf(proofs({ onchain: [tx(due80, 3)] }))).toMatchObject({
      state: "paid",
      method: "onchain"
    });
  });

  it("takes an on-chain payment short by no more than the tolerance, never a Lightning one", () => {
    const short = due80 - (due80 * 500n) / 10_000n;
    expect(verdictOf(proofs({ tolerance: 500, onchain: [tx(short, 3)] }))).toMatchObject({
      state: "paid",
      accepted: true
    });
    expect(verdictOf(proofs({ tolerance: 500, onchain: [tx(short - 1n, 3)] })).state).toBe(
      "underpaid"
    );
    expect(verdictOf(proofs({ tolerance: 500, lightning: [ln(short)] })).state).toBe("underpaid");
  });

  it("adds Lightning and on-chain payments", () => {
    expect(
      verdictOf(proofs({ lightning: [ln(1_000_000n)], onchain: [tx(due80 - 1_000_000n, 4)] }))
    ).toMatchObject({
      state: "paid",
      method: "mixed",
      received: due80
    });
  });

  it("waits for the price of an hour that decides, never says underpaid meanwhile", () => {
    const points = new Map([[hour, 80_000]]);
    expect(verdictOf(proofs({ lightning: [ln(1_000_000n, hour - 3600)], points }))).toEqual({
      state: "checking",
      reason: "price"
    });
  });

  it("is expired past the end only when nothing may still be told paid", () => {
    const ended = { now: hour + 7200, endsAt: hour + 3600 };
    expect(verdictOf(proofs({ ...ended, openInvoiceEnds: [hour + 3600] })).state).toBe("checking");
    expect(verdictOf(proofs(ended))).toEqual({ state: "expired" });
  });
});
