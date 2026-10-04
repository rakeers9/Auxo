import { choice, TypeSafeClient, type EntryType, type Fetch } from "@typesafe-ai/sdk";
import { z } from "zod";

import type { Budget, Cart, Lane, Rule } from "@auxo/shared";

const JevSignalSchema = z.object({
  lane: z.enum(["L0", "L1", "L2", "L3", "L4"]),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.enum(["L0", "L1", "L2", "L3", "L4"]), z.number().min(0).max(1)),
  model: z.string().min(1),
});

export type JevSignal = z.infer<typeof JevSignalSchema>;

export interface JevState {
  cart: Cart;
  rules: Rule[];
  budgets: Budget[];
  deterministicLane: Lane;
}

export interface JevDecisionProvider {
  readonly modelVersion: string;
  evaluate(state: JevState): Promise<JevSignal>;
}

export interface TypeSafeJevProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: Fetch;
}

export class TypeSafeJevProvider implements JevDecisionProvider {
  private readonly client: TypeSafeClient;
  private readonly timeoutMs: number;
  public readonly modelVersion: string;

  public constructor(options: TypeSafeJevProviderOptions) {
    this.modelVersion = options.model ?? "jev-latest";
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.client = new TypeSafeClient({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      defaultModel: this.modelVersion,
      timeout: this.timeoutMs,
      retry: { maxRetries: 0 },
      logLevel: "off",
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  public async evaluate(state: JevState): Promise<JevSignal> {
    const response = await this.client.systemOne(
      {
        state: toJsonValue({
          cart: state.cart,
          enabled_rules: state.rules.filter((rule) => rule.enabled),
          active_budgets: state.budgets,
          deterministic_policy_lane: state.deterministicLane,
        }),
        questions: {
          intervention_lane: choice(
            "Choose the appropriate shopping intervention lane. Prefer the least restrictive lane that still addresses likely impulsive or harmful spending. Never weaken the deterministic policy lane.",
            {
              L0: "Allow silently; no meaningful intervention is warranted.",
              L1: "Allow with a light awareness banner.",
              L2: "Pause briefly so the user can reconsider.",
              L3: "Block temporarily because the purchase appears meaningfully risky.",
              L4: "Use the strongest block because the purchase appears clearly harmful or violates a hard constraint.",
            },
          ),
        },
      },
      { timeout: this.timeoutMs, retry: { maxRetries: 0 } },
    );

    const answer = response.answers.intervention_lane;
    return JevSignalSchema.parse({
      lane: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      model: response.model,
    });
  }
}

function toJsonValue(value: unknown): EntryType {
  return JSON.parse(JSON.stringify(value)) as EntryType;
}
