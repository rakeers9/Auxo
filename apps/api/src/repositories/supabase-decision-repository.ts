import type { SupabaseClient } from "@supabase/supabase-js";

import { CartSchema, VerdictSchema } from "@auxo/shared";
import { z } from "zod";

import type { DecisionRecord, DecisionRepository, OwnedDecision } from "./decision-repository.js";

const TimestampSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)))
  .transform((value) => new Date(value).toISOString());

// A decisions row as selected by findOwned. Parsed rather than cast so a bad
// row fails here with a clear error instead of deep in the pass service.
const OwnedDecisionRowSchema = z.object({
  id: z.string(),
  cart: CartSchema,
  lane: z.string(),
  action: z.string(),
  template_id: z.string(),
  cooldown_seconds: z.number(),
  created_at: TimestampSchema,
  expires_at: TimestampSchema,
});

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
      .select("id,cart,lane,action,template_id,cooldown_seconds,created_at,expires_at")
      .eq("id", decisionId)
      .eq("user_id", userId)
      .maybeSingle<unknown>();
    if (error) throw new Error("Unable to load the decision.", { cause: error });
    if (!data) return null;
    const row = OwnedDecisionRowSchema.safeParse(data);
    if (!row.success) throw new Error("The stored decision is invalid.", { cause: row.error });
    return {
      cart: row.data.cart,
      verdict: VerdictSchema.parse({
        decision_id: row.data.id,
        lane: row.data.lane,
        action: row.data.action,
        template_id: row.data.template_id,
        cooldown_seconds: row.data.cooldown_seconds,
      }),
      createdAt: row.data.created_at,
      expiresAt: row.data.expires_at,
    };
  }
}
