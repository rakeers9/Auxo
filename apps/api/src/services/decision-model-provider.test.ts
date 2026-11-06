import { describe, expect, it, vi } from "vitest";

import type { Cart, DecisionHistory, Rule } from "@auxo/shared";
import { CloudflareClefProvider, MAX_DESCRIPTION_RULES_PER_REQUEST } from "./decision-model-provider.js";

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

describe("CloudflareClefProvider free-text rules (AUX-50)", () => {
  const laneAnswer = {
    type: "choice",
    choice: "L0",
    confidence: 0.9,
    probabilities: { L0: 0.9, L1: 0.05, L2: 0.05, L3: 0, L4: 0 },
  };
  let counter = 0;
  function descriptionRule(configuration: Record<string, unknown>, overrides: Partial<Rule> = {}): Rule {
    counter += 1;
    return {
      id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
      name: "Free text",
      rule_type: "description",
      configuration,
      enabled: true,
      created_at: "2026-11-06T12:00:00.000Z",
      updated_at: "2026-11-06T12:00:00.000Z",
      ...overrides,
    };
  }
  function clef(answers: Record<string, unknown>) {
    return vi.fn(async () =>
      new Response(JSON.stringify({ result: { model: "clef", answers: { intervention_lane: laneAnswer, ...answers } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }
  type SentQuestion = { type: string; instructions: { question: string; user_rule: string }; criteria: unknown };
  function sentQuestions(request: ReturnType<typeof clef>): Record<string, SentQuestion> {
    const [, init] = (request.mock.calls[0] ?? []) as unknown as [string, RequestInit];
    return (JSON.parse(String(init.body)) as { questions: Record<string, SentQuestion> }).questions;
  }

  it("asks a yes/no question per rule, and a lane question only for a rule without a lane", async () => {
    const withLane = descriptionRule({ description: "I don't want to buy clothes", lane: "L2" });
    const withoutLane = descriptionRule({ description: "No more gadgets" });
    const request = clef({});
    const provider = new CloudflareClefProvider({ accountId: "a", apiToken: "t", fetch: request });

    await provider.evaluate({ cart, rules: [withLane, withoutLane], budgets: [], deterministicLane: "L0" });

    const questions = sentQuestions(request);
    expect(Object.keys(questions).sort()).toEqual([
      "intervention_lane",
      `rule.${withLane.id}.applies`,
      `rule.${withoutLane.id}.applies`,
      `rule.${withoutLane.id}.lane`,
    ].sort());
    const applies = questions[`rule.${withLane.id}.applies`]!;
    expect(applies.type).toBe("noul");
    // The user's words travel in their own field, not inside the question text.
    expect(applies.instructions.user_rule).toBe("I don't want to buy clothes");
    expect(applies.instructions.question).not.toContain("clothes");
    expect(applies.criteria).toEqual({ true: expect.any(String), false: expect.any(String) });
    const lane = questions[`rule.${withoutLane.id}.lane`]!;
    expect(lane.type).toBe("choice");
    expect(Object.keys(lane.criteria as object)).toEqual(["L0", "L1", "L2", "L3", "L4"]);
  });

  it("returns each rule's answer, with the model's lane for a rule without one", async () => {
    const withLane = descriptionRule({ description: "Clothes", lane: "L2" });
    const withoutLane = descriptionRule({ description: "Gadgets" });
    const provider = new CloudflareClefProvider({
      accountId: "a",
      apiToken: "t",
      fetch: clef({
        [`rule.${withLane.id}.applies`]: { type: "noul", noul: 0.92 },
        [`rule.${withoutLane.id}.applies`]: { type: "noul", noul: 0.7 },
        [`rule.${withoutLane.id}.lane`]: { ...laneAnswer, choice: "L3" },
      }),
    });

    const signal = await provider.evaluate({ cart, rules: [withLane, withoutLane], budgets: [], deterministicLane: "L0" });

    expect(signal.lane).toBe("L0");
    expect(signal.rules).toEqual([
      { rule_id: withLane.id, applies: 0.92 },
      { rule_id: withoutLane.id, applies: 0.7, lane: "L3" },
    ]);
  });

  it("leaves out a rule whose answer is missing or malformed, without failing the signal", async () => {
    const missing = descriptionRule({ description: "Clothes", lane: "L2" });
    const malformed = descriptionRule({ description: "Gadgets", lane: "L2" });
    const badLane = descriptionRule({ description: "Snacks" });
    const provider = new CloudflareClefProvider({
      accountId: "a",
      apiToken: "t",
      fetch: clef({
        [`rule.${malformed.id}.applies`]: { type: "noul", noul: 7 },
        [`rule.${badLane.id}.applies`]: { type: "noul", noul: 0.8 },
        [`rule.${badLane.id}.lane`]: { ...laneAnswer, choice: "L9" },
      }),
    });

    const signal = await provider.evaluate({ cart, rules: [missing, malformed, badLane], budgets: [], deterministicLane: "L0" });

    expect(signal.rules).toEqual([{ rule_id: badLane.id, applies: 0.8 }]);
  });

  it("skips disabled and broken rules and caps the questions at Clef's limit of 64", async () => {
    const disabled = descriptionRule({ description: "Clothes" }, { enabled: false });
    const broken = descriptionRule({ description: "" });
    const many = Array.from({ length: MAX_DESCRIPTION_RULES_PER_REQUEST + 5 }, (_, index) =>
      descriptionRule({ description: `Rule ${index}` }),
    );
    const request = clef({});
    const provider = new CloudflareClefProvider({ accountId: "a", apiToken: "t", fetch: request });

    await provider.evaluate({ cart, rules: [disabled, broken, ...many], budgets: [], deterministicLane: "L0" });

    const questions = sentQuestions(request);
    expect(Object.keys(questions)).toHaveLength(1 + 2 * MAX_DESCRIPTION_RULES_PER_REQUEST);
    expect(Object.keys(questions).length).toBeLessThanOrEqual(64);
    expect(questions[`rule.${disabled.id}.applies`]).toBeUndefined();
    expect(questions[`rule.${broken.id}.applies`]).toBeUndefined();
  });

  it("adds no rule answers when there are no free-text rules", async () => {
    const provider = new CloudflareClefProvider({ accountId: "a", apiToken: "t", fetch: clef({}) });
    const signal = await provider.evaluate({ cart, rules: [], budgets: [], deterministicLane: "L0" });
    expect(signal).not.toHaveProperty("rules");
  });
});
