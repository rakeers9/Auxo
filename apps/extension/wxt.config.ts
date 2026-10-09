import { defineConfig } from "wxt";

// The API origin the background worker may call. Override with WXT_API_BASE_URL.
const apiBaseUrl = process.env.WXT_API_BASE_URL ?? "https://api-ten-sand-28.vercel.app";

const DEV_ONLY_ENTRYPOINTS = new Set(["shopify", "generic"]);

export default defineConfig({
  // Explicit imports only: every module imports what it uses.
  imports: false,
  vite: () => ({ css: { postcss: { plugins: [] } } }),
  manifest: {
    name: "Auxo",
    description: "Adds a moment of friction before impulse purchases.",
    host_permissions: [`${new URL(apiBaseUrl).origin}/*`, "https://*.supabase.co/*"],
    // storage.session: the worker's memory of recent decisions (no install warning).
    permissions: ["storage"],
  },
  hooks: {
    // Content scripts that run on every site (any Shopify store) ship in dev
    // builds only, until the "read data on all websites" permission is decided.
    "entrypoints:resolved": (wxt, entrypoints) => {
      if (wxt.config.mode === "development") return;
      for (const entrypoint of entrypoints) {
        if (DEV_ONLY_ENTRYPOINTS.has(entrypoint.name)) entrypoint.skipped = true;
      }
    },
  },
});
