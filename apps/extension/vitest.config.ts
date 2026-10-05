import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts", "entrypoints/**/*.test.ts"],
    // DOMParser tests over large real fixtures can exceed 5s when several
    // sessions run suites at once.
    testTimeout: 15_000,
  },
});
