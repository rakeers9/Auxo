import type { SupabaseClient } from "@supabase/supabase-js";
import { PassSchema, type Pass } from "@auxo/shared";

import type { CreatePassRecord, PassRepository } from "./pass-repository.js";

interface PassRow { id: string; decision_id: string; cart_hash: string; merchant: string; expires_at: string }

export class SupabasePassRepository implements PassRepository {
  public constructor(private readonly client: SupabaseClient) {}

  public async create(record: CreatePassRecord): Promise<Pass> {
    const { data: existing, error: existingError } = await this.client.from("passes")
      .select("id,decision_id,cart_hash,merchant,expires_at")
      .eq("user_id", record.userId).eq("decision_id", record.decisionId).maybeSingle<PassRow>();
    if (existingError) throw new Error("Unable to load the existing pass.", { cause: existingError });
    if (existing) return toPass(existing);

    const { data, error } = await this.client.from("passes").insert({
      user_id: record.userId,
      decision_id: record.decisionId,
      cart_hash: record.cartHash,
      merchant: record.merchant,
      issued_at: record.issuedAt,
      expires_at: record.expiresAt,
    }).select("id,decision_id,cart_hash,merchant,expires_at").single<PassRow>();
    if (error) throw new Error("Unable to issue the pass.", { cause: error });
    return toPass(data);
  }

  public async findActive(userId: string, cartHash: string, now: Date): Promise<Pass | null> {
    const { data, error } = await this.client.from("passes")
      .select("id,decision_id,cart_hash,merchant,expires_at")
      .eq("user_id", userId).eq("cart_hash", cartHash).is("revoked_at", null)
      .gt("expires_at", now.toISOString()).order("expires_at", { ascending: false }).limit(1).maybeSingle<PassRow>();
    if (error) throw new Error("Unable to load the active pass.", { cause: error });
    return data ? toPass(data) : null;
  }
}

function toPass(row: PassRow): Pass {
  return PassSchema.parse({ pass_id: row.id, decision_id: row.decision_id, cart_hash: row.cart_hash, merchant: row.merchant, expires_at: row.expires_at });
}
