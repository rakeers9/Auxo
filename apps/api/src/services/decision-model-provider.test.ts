import { describe, expect, it, vi } from "vitest";

import type { Cart, DecisionHistory } from "@auxo/shared";
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
      state: { cart: { merchant: "Example Store" }, deterministic_policy_lane: "L0", merchant_history: null },
      questions: { intervention_lane: { type: "choice" } },
    });
  });

  it("sends the merchant history in the state when it loaded (AUX-34)", async () => {
    const request = vi.fn(async () =>
      new Response(
        JSON.stringify({
          result: {
            model: "clef",
            answers: {
              intervention_lane: {
                type: "choice",
                choice: "L1",
                confidence: 0.6,
                probabilities: { L0: 0.2, L1: 0.6, L2: 0.1, L3: 0.05, L4: 0.05 },
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = new CloudflareClefProvider({ accountId: "account-id", apiToken: "test-token", fetch: request });
    const history: DecisionHistory = {
      merchant: "Example Store",
      window_days: 30,
      purchases: 3,
      spent_minor: 36_000,
      check_ins: 2,
      regret_rate: 1,
      override_rate: 0.5,
    };

    await provider.evaluate({ cart, rules: [], budgets: [], deterministicLane: "L0", history });

    const [, init] = request.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as { state: Record<string, unknown>; questions: { intervention_lane: { instructions: string } } };
    expect(body.state.merchant_history).toEqual(history);
    expect(body.questions.intervention_lane.instructions).toContain("merchant_history");
  });

  it("rejects provider errors and malformed output", async () => {
    const provider = new CloudflareClefProvider({
      accountId: "account-id",
      apiToken: "test-token",
      fetch: async () => new Response("unavailable", { status: 503 }),
    });
    await expect(provider.evaluate({ cart, rules: [], budgets: [], deterministicLane: "L0" })).rejects.toThrow("503");
  });

  it("rejects a lane outside L0-L4", async () => {
    const provider = new CloudflareClefProvider({
      accountId: "account-id",
      apiToken: "test-token",
      fetch: async () =>
        new Response(
          JSON.stringify({
            result: {
              model: "clef",
              answers: {
                intervention_lane: {
                  type: "choice",
                  choice: "L5",
                  confidence: 0.5,
                  probabilities: { L0: 0.1, L1: 0.1, L2: 0.1, L3: 0.1, L4: 0.1 },
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    await expect(provider.evaluate({ cart, rules: [], budgets: [], deterministicLane: "L0" })).rejects.toThrow();
  });
});
