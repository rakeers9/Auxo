import type { SupabaseClient } from "@supabase/supabase-js";
import { PassSchema, type Pass } from "@auxo/shared";

import type { IssuePassRecord, PassRepository } from "./pass-repository.js";

interface PassRow { id: string; decision_id: string; cart_hash: string; merchant: string; expires_at: string }

const passColumns = "id,decision_id,cart_hash,merchant,expires_at";

// The passes table allows at most one unrevoked pass per decision (partial
// unique index passes_one_unrevoked_per_decision_idx). An expired pass is
// retired (revoked_at set) before a new one is inserted, and a concurrent
// insert that loses the race gets 23505 and returns the winner instead.
export class SupabasePassRepository implements PassRepository {
  public constructor(private readonly client: SupabaseClient) {}

  public async issue(record: IssuePassRecord): Promise<Pass> {
    const existing = await this.findActiveForDecision(record.userId, record.decisionId, record.issuedAt);
    if (existing) return existing;

    const { error: retireError } = await this.client.from("passes")
      .update({ revoked_at: record.issuedAt })
      .eq("user_id", record.userId).eq("decision_id", record.decisionId)
      .is("revoked_at", null).lte("expires_at", record.issuedAt);
    if (retireError) throw new Error("Unable to retire the expired pass.", { cause: retireError });

    const { data, error } = await this.client.from("passes").insert({
      user_id: record.userId,
      decision_id: record.decisionId,
      cart_hash: record.cartHash.toLowerCase(),
      merchant: record.merchant,
      issued_at: record.issuedAt,
      expires_at: record.expiresAt,
    }).select(passColumns).single<PassRow>();
    if (!error) return toPass(data);

    if (error.code === "23505") {
      // Another request issued the pass between our read and insert.
      const winner = await this.findActiveForDecision(record.userId, record.decisionId, record.issuedAt);
      if (winner) return winner;
    }
    throw new Error("Unable to issue the pass.", { cause: error });
  }

  public async findActive(userId: string, cartHash: string, now: Date): Promise<Pass | null> {
    const { data, error } = await this.client.from("passes")
      .select(passColumns)
      .eq("user_id", userId).eq("cart_hash", cartHash.toLowerCase()).is("revoked_at", null)
      .gt("expires_at", now.toISOString()).order("expires_at", { ascending: false }).limit(1).maybeSingle<PassRow>();
    if (error) throw new Error("Unable to load the active pass.", { cause: error });
    return data ? toPass(data) : null;
  }

  private async findActiveForDecision(userId: string, decisionId: string, now: string): Promise<Pass | null> {
    const { data, error } = await this.client.from("passes")
      .select(passColumns)
      .eq("user_id", userId).eq("decision_id", decisionId).is("revoked_at", null)
      .gt("expires_at", now).order("expires_at", { ascending: false }).limit(1).maybeSingle<PassRow>();
    if (error) throw new Error("Unable to load the existing pass.", { cause: error });
    return data ? toPass(data) : null;
  }
}

function toPass(row: PassRow): Pass {
  return PassSchema.parse({
    pass_id: row.id,
    decision_id: row.decision_id,
    cart_hash: row.cart_hash.toLowerCase(),
    merchant: row.merchant,
    expires_at: new Date(row.expires_at).toISOString(),
  });
}
