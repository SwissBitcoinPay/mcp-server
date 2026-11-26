import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The invoice card, which the server serves (src/mcp/card.ts), built from ui/ first.
    globalSetup: ["test/helpers/build-card.ts"],
    // Local relays (vendor/checkout-node/test/helpers/relay.ts) and timeouts: a busy CI runner needs
    // more than 5 s.
    testTimeout: 15_000
  }
});
