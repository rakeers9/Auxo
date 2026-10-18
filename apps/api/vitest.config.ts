import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Collecting the Fastify + Supabase imports can take over 10s on a cold
    // Windows run, which timed out the first test at the 5s default.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
