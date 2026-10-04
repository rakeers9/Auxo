import { describe, expect, it, vi } from "vitest";

import type { Cart } from "@auxo/shared";
import { TypeSafeJevProvider } from "./jev-provider.js";

const cart: Cart = {
  merchant: "Example Store",
  items: [{ name: "Sneakers", price_minor: 12_000, qty: 1 }],
  total_minor: 12_000,
  currency: "USD",
  url: "https://example.com/cart",
  cart_hash: "a".repeat(64),
};

describe("TypeSafeJevProvider", () => {
  it("sends typed state and validates the Jev choice response", async () => {
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            intervention_lane: {
              type: "choice",
              choice: "L2",
              confidence: 0.81,
              probabilities: { L0: 0.02, L1: 0.07, L2: 0.81, L3: 0.08, L4: 0.02 },
            },
          },
          usage: { input_tokens: 120, output_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = new TypeSafeJevProvider({ apiKey: "test-key", fetch });

    const signal = await provider.evaluate({
      cart,
      rules: [],
      budgets: [],
      deterministicLane: "L0",
    });

    expect(signal).toMatchObject({ lane: "L2", confidence: 0.81, model: "jev-1.13.0" });
    expect(fetch).toHaveBeenCalledOnce();
    const [, request] = fetch.mock.calls[0] ?? [];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model: "jev-latest",
      state: { cart: { merchant: "Example Store" }, deterministic_policy_lane: "L0" },
      questions: { intervention_lane: { type: "choice" } },
    });
  });

  it("rejects a malformed response", async () => {
    const provider = new TypeSafeJevProvider({
      apiKey: "test-key",
      fetch: async () =>
        new Response(
          JSON.stringify({
            model: "jev-latest",
            answers: { intervention_lane: { type: "choice", choice: "L9", confidence: 1, probabilities: {} } },
            usage: { input_tokens: 1, output_tokens: 0 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    await expect(provider.evaluate({ cart, rules: [], budgets: [], deterministicLane: "L0" })).rejects.toThrow();
  });
});
