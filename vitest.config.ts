import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Wrangler validates declared required secrets before Miniflare bindings are
// created. Keep deterministic test-only values in this process, never in a
// deployable vars block.
process.env.DATA_ENCRYPTION_KEY ??= "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
process.env.BOOTSTRAP_ADMIN_PASSWORD ??= "test-bootstrap-password-2026";
process.env.BOOTSTRAP_GATEWAY_API_KEY ??= "m365_test_deployment_key_1234567890";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          DATA_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
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
  },
});
