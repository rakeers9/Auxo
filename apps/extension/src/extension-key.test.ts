import { describe, expect, it } from "vitest";

import { EXTENSION_ID, EXTENSION_PUBLIC_KEY } from "./extension-key";

// Chrome's rule: SHA-256 of the DER public key, first 32 hex digits, with
// 0-9a-f mapped to a-p.
async function idFromKey(base64Key: string): Promise<string> {
  const der = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", der));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  return Array.from(hex, (c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");
}

describe("extension key", () => {
  it("matches the documented extension ID", async () => {
    expect(await idFromKey(EXTENSION_PUBLIC_KEY)).toBe(EXTENSION_ID);
  });
});
