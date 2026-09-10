import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Wrangler validates declared required secrets before Miniflare bindings are
// created. Keep deterministic test-only values in this process, never in a
// deployable vars block.
process.env.DATA_ENCRYPTION_KEY ??= "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
process.env.COMPACTION_ENCRYPTION_KEY ??= "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
process.env.BOOTSTRAP_ADMIN_PASSWORD ??= "test-bootstrap-password-2026";
process.env.BOOTSTRAP_GATEWAY_API_KEY ??= "m365_test_deployment_key_1234567890";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          DATA_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          COMPACTION_ENCRYPTION_KEY: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
          BOOTSTRAP_ADMIN_PASSWORD: "test-bootstrap-password-2026",
          BOOTSTRAP_GATEWAY_API_KEY: "m365_test_deployment_key_1234567890",
          // Keep legacy recovery tests explicit; production deploys set the
          // direct native model/tool loop in wrangler.jsonc.
          DIRECT_NATIVE_TOOL_MODE: "false",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // The Responses/DO integration fixtures can take just over five seconds
    // when the full 25-file suite starts together. Keep the test gate strict,
    // but avoid treating normal worker startup contention as a code failure.
    testTimeout: 15_000,
  },
});
