import type { SupabaseClient } from "@supabase/supabase-js";

import { DecisionHistorySchema, type DecisionHistory } from "@auxo/shared";
import { z } from "zod";

import type { HistoryQuery, HistoryRepository } from "./history-repository.js";

const Count = z.number().int().nonnegative();

// What merchant_history (migration 202610180003) returns.
const MerchantHistoryRowSchema = z.object({
  purchases: Count,
  spent_minor: Count,
  check_ins: Count,
  regrets: Count,
  guarded: Count,
  overridden: Count,
});

export class SupabaseHistoryRepository implements HistoryRepository {
  public constructor(private readonly client: SupabaseClient) {}

  public async merchantHistory(userId: string, query: HistoryQuery): Promise<DecisionHistory> {
    const until = query.now;
    const since = new Date(until.getTime() - query.windowDays * 86_400_000);
    const { data, error } = await this.client.rpc("merchant_history", {
      p_user_id: userId,
      p_merchant: query.merchant,
      p_currency: query.currency,
      p_since: since.toISOString(),
      p_until: until.toISOString(),
    });

    if (error) {
      throw new Error("Unable to load the merchant history.", { cause: error });
    }

    const row = MerchantHistoryRowSchema.safeParse(data);
    if (!row.success) {
      throw new Error("Unexpected result from merchant_history.", { cause: row.error });
    }

    const counts = row.data;
    return DecisionHistorySchema.parse({
      merchant: query.merchant,
      window_days: query.windowDays,
      purchases: counts.purchases,
      spent_minor: counts.spent_minor,
      check_ins: counts.check_ins,
      regret_rate: counts.check_ins > 0 ? counts.regrets / counts.check_ins : null,
      override_rate: counts.guarded > 0 ? counts.overridden / counts.guarded : null,
    });
  }
}
