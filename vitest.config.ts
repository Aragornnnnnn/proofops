import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        bindings: {
          GITHUB_OAUTH_CLIENT_ID: "test-github-client",
          GITHUB_OAUTH_CLIENT_SECRET: "test-github-secret",
          GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
          PROOFOPS_ALLOWED_GITHUB_LOGINS: "alice,bob,carol",
        },
      },
    }),
  ],
});
