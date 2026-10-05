import { describe, expect, it, vi } from "vitest";

import type { Cart } from "@auxo/shared";
import { CloudflareClefProvider } from "./decision-model-provider.js";

const cart: Cart = {
  merchant: "Example Store",
  items: [{ name: "Sneakers", price_minor: 12_000, qty: 1 }],
  total_minor: 12_000,
  currency: "USD",
  url: "https://example.com/cart",
  cart_hash: "a".repeat(64),
};

describe("CloudflareClefProvider", () => {
  it("sends System One state and validates the Clef response", async () => {
    const request = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: {
            model: "clef",
            answers: {
              intervention_lane: {
                type: "choice",
                choice: "L2",
                confidence: 0.81,
                probabilities: { L0: 0.02, L1: 0.07, L2: 0.81, L3: 0.08, L4: 0.02 },
              },
            },
            usage: { input_tokens: 120, output_tokens: 0 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = new CloudflareClefProvider({
      accountId: "account-id",
      apiToken: "test-token",
      fetch: request,
    });

    const signal = await provider.evaluate({ cart, rules: [], budgets: [], deterministicLane: "L0" });

    expect(signal).toMatchObject({ lane: "L2", confidence: 0.81, model: "clef" });
    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toContain("/accounts/account-id/ai/run/@cf/cloudflare/clef");
    expect(init?.headers).toMatchObject({ authorization: "Bearer test-token" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "clef",
      state: { cart: { merchant: "Example Store" }, deterministic_policy_lane: "L0" },
      questions: { intervention_lane: { type: "choice" } },
    });
  });

  it("rejects provider errors and malformed output", async () => {
    const provider = new CloudflareClefProvider({
      accountId: "account-id",
      apiToken: "test-token",
      fetch: async () => new Response("unavailable", { status: 503 }),
    });
    await expect(provider.evaluate({ cart, rules: [], budgets: [], deterministicLane: "L0" })).rejects.toThrow("503");
  });
});
