import { describe, expect, it } from "vitest";

// @ts-expect-error: a plain ES module of the repository's tooling, without types.
import { checkCopy } from "../scripts/spec.mjs";
// @ts-expect-error: a plain ES module of the repository's tooling, without types.
import { checkVendor } from "../scripts/vendor.mjs";

/*
 * What this server takes from elsewhere, unchanged: the integrations' specification (spec/,
 * sattleme/checkout-spec, whose rules SPEC.md names) and the code of sattleme/checkout-node that
 * implements them (vendor/checkout-node/). Each changes only by taking a newer version of its
 * repository (node scripts/spec.mjs import, node scripts/vendor.mjs import), never by hand.
 */
describe("the pinned copies", () => {
  it("spec/ is the copy PIN.json pins", () => {
    expect((checkCopy as () => string[])()).toEqual([]);
  });

  it("vendor/checkout-node/ is the copy VENDOR.json pins", () => {
    expect((checkVendor as () => string[])()).toEqual([]);
  });
});
