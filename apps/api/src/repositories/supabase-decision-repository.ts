import type { SupabaseClient } from "@supabase/supabase-js";

import { DecisionContextSchema, VerdictSchema, type DecideResponse } from "@auxo/shared";

import type { DecisionRecord, DecisionRepository } from "./decision-repository.js";

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

  public async findActive(
    userId: string,
    cartHash: string,
    policyVersion: string,
    now: Date,
  ): Promise<DecideResponse | null> {
    const { data, error } = await this.client
      .from("decisions")
      .select("id,lane,action,template_id,cooldown_seconds,decision_context")
      .eq("user_id", userId)
      .eq("cart_hash", cartHash)
      .eq("policy_version", policyVersion)
      .gt("expires_at", now.toISOString())
      .maybeSingle<DecisionRow>();

    if (error) {
      throw new Error("Unable to load an existing decision.", { cause: error });
    }

    if (!data) {
      return null;
    }

    const verdict = VerdictSchema.parse({
      decision_id: data.id,
      lane: data.lane,
      action: data.action,
      template_id: data.template_id,
      cooldown_seconds: data.cooldown_seconds,
    });
    return { ...verdict, context: DecisionContextSchema.parse(data.decision_context) };
  }

  public async save(record: DecisionRecord): Promise<void> {
    const { error } = await this.client.from("decisions").upsert(
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
        expires_at: record.expiresAt,
      },
      {
        onConflict: "user_id,cart_hash,policy_version",
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
}
