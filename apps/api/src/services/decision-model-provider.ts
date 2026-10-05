import { z } from "zod";

import type { Budget, Cart, Lane, Rule } from "@auxo/shared";

const DecisionSignalSchema = z.object({
  lane: z.enum(["L0", "L1", "L2", "L3", "L4"]),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.enum(["L0", "L1", "L2", "L3", "L4"]), z.number().min(0).max(1)),
  model: z.string().min(1),
});

const ClefResultSchema = z.object({
  model: z.string().min(1),
  answers: z.object({
    intervention_lane: z.object({
      type: z.literal("choice"),
      choice: z.enum(["L0", "L1", "L2", "L3", "L4"]),
      confidence: z.number().min(0).max(1),
      probabilities: z.record(
        z.enum(["L0", "L1", "L2", "L3", "L4"]),
        z.number().min(0).max(1),
      ),
    }),
  }),
});

export type DecisionSignal = z.infer<typeof DecisionSignalSchema>;

export interface DecisionModelState {
  cart: Cart;
  rules: Rule[];
  budgets: Budget[];
  deterministicLane: Lane;
}

export interface DecisionModelProvider {
  readonly modelVersion: string;
  evaluate(state: DecisionModelState): Promise<DecisionSignal>;
}

export interface CloudflareClefProviderOptions {
  accountId: string;
  apiToken: string;
  model?: "clef" | "clef-flash";
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class CloudflareClefProvider implements DecisionModelProvider {
  private readonly endpoint: string;
  private readonly apiToken: string;
  private readonly timeoutMs: number;
  private readonly request: typeof fetch;
  public readonly modelVersion: "clef" | "clef-flash";

  public constructor(options: CloudflareClefProviderOptions) {
    this.modelVersion = options.model ?? "clef";
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.apiToken = options.apiToken;
    this.request = options.fetch ?? fetch;
    this.endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/ai/run/@cf/cloudflare/${this.modelVersion}`;
  }

  public async evaluate(state: DecisionModelState): Promise<DecisionSignal> {
    const response = await this.request(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.modelVersion,
        state: {
          cart: state.cart,
          enabled_rules: state.rules.filter((rule) => rule.enabled),
          active_budgets: state.budgets,
          deterministic_policy_lane: state.deterministicLane,
        },
        questions: {
          intervention_lane: {
            type: "choice",
            instructions:
              "Choose the appropriate shopping intervention lane. Prefer the least restrictive lane that still addresses likely impulsive or harmful spending. Never weaken the deterministic policy lane.",
            criteria: {
              L0: "Allow silently; no meaningful intervention is warranted.",
              L1: "Allow with a light awareness banner.",
              L2: "Pause briefly so the user can reconsider.",
              L3: "Block temporarily because the purchase appears meaningfully risky.",
              L4: "Use the strongest block because the purchase appears clearly harmful or violates a hard constraint.",
            },
          },
        },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Cloudflare Clef request failed with status ${response.status}.`);
    }

    const body: unknown = await response.json();
    const result = ClefResultSchema.parse(unwrapCloudflareResult(body));
    const answer = result.answers.intervention_lane;
    return DecisionSignalSchema.parse({
      lane: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      model: result.model,
    });
  }
}

function unwrapCloudflareResult(body: unknown): unknown {
  if (typeof body === "object" && body !== null && "result" in body) {
    return (body as { result: unknown }).result;
  }
  return body;
}
