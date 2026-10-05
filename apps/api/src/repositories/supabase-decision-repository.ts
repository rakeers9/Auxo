import type { SupabaseClient } from "@supabase/supabase-js";

import { VerdictSchema } from "@auxo/shared";

import type { DecisionRecord, DecisionRepository, OwnedDecision } from "./decision-repository.js";

interface DecisionRow {
  id: string;
  lane: string;
  action: string;
  template_id: string;
  cooldown_seconds: number;
  decision_context: unknown;
}

export class SupabaseDecisionRepository implements DecisionRepository {
  public constructor(private readonly client: SupabaseClient) {}

  public async save(record: DecisionRecord): Promise<void> {
    const { error } = await this.client.from("decisions").insert(
      {
        id: record.verdict.decision_id,
        user_id: record.userId,
        cart_hash: record.cart.cart_hash,
        cart: record.cart,
        lane: record.verdict.lane,
        action: record.verdict.action,
        template_id: record.verdict.template_id,
        cooldown_seconds: record.verdict.cooldown_seconds,
        policy_version: record.policyVersion,
        model_provider: record.modelProvider,
        model_version: record.modelVersion,
        model_output: record.modelOutput ?? null,
        decision_context: record.context,
        trigger: record.trigger ?? null,
        expires_at: record.expiresAt,
      },
    );

    if (error) {
      throw new Error("Unable to persist the decision.", { cause: error });
    }
  }

  public async belongsToUser(userId: string, decisionId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from("decisions")
      .select("id")
      .eq("id", decisionId)
      .eq("user_id", userId)
      .maybeSingle<{ id: string }>();

    if (error) {
      throw new Error("Unable to verify decision ownership.", { cause: error });
    }

    return data !== null;
  }

  public async findOwned(userId: string, decisionId: string): Promise<OwnedDecision | null> {
    const { data, error } = await this.client
      .from("decisions")
      .select("id,cart,lane,action,template_id,cooldown_seconds,created_at")
      .eq("id", decisionId)
      .eq("user_id", userId)
      .maybeSingle<DecisionRow & { cart: unknown; created_at: string }>();
    if (error) throw new Error("Unable to load the decision.", { cause: error });
    if (!data) return null;
    return {
      cart: data.cart as OwnedDecision["cart"],
      verdict: VerdictSchema.parse({
        decision_id: data.id,
        lane: data.lane,
        action: data.action,
        template_id: data.template_id,
        cooldown_seconds: data.cooldown_seconds,
      }),
      createdAt: data.created_at,
    };
  }
}
