import { defineConfig } from "wxt";

// The API origin the background worker may call. Override with WXT_API_BASE_URL.
const apiBaseUrl = process.env.WXT_API_BASE_URL ?? "http://127.0.0.1:3001";

export default defineConfig({
  // Explicit imports only: every module imports what it uses.
  imports: false,
  manifest: {
    name: "Auxo",
    description: "Adds a moment of friction before impulse purchases.",
    host_permissions: [`${new URL(apiBaseUrl).origin}/*`],
  },
});
