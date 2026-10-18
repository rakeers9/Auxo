import { describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { SupabaseHistoryRepository } from "./supabase-history-repository.js";

const userId = "20000000-0000-4000-8000-000000000001";
const now = new Date("2026-10-18T12:00:00.000Z");
const query = { merchant: "Example Store", currency: "USD", now, windowDays: 30 };

function client(response: { data?: unknown; error?: { message: string } | null }) {
  const rpc = vi.fn(async () => ({ data: response.data ?? null, error: response.error ?? null }));
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe("SupabaseHistoryRepository", () => {
  it("calls merchant_history for the window and turns counts into rates", async () => {
    const { client: supabase, rpc } = client({
      data: { purchases: 3, spent_minor: 4_500, check_ins: 4, regrets: 1, guarded: 2, overridden: 2 },
    });

    const history = await new SupabaseHistoryRepository(supabase).merchantHistory(userId, query);

    expect(rpc).toHaveBeenCalledWith("merchant_history", {
      p_user_id: userId,
      p_merchant: "Example Store",
      p_currency: "USD",
      p_since: "2026-09-18T12:00:00.000Z",
      p_until: "2026-10-18T12:00:00.000Z",
    });
    expect(history).toEqual({
      merchant: "Example Store",
      window_days: 30,
      purchases: 3,
      spent_minor: 4_500,
      check_ins: 4,
      regret_rate: 0.25,
      override_rate: 1,
    });
  });

  it("returns null rates with no check-ins or guarded decisions", async () => {
    const { client: supabase } = client({
      data: { purchases: 0, spent_minor: 0, check_ins: 0, regrets: 0, guarded: 0, overridden: 0 },
    });
    expect(await new SupabaseHistoryRepository(supabase).merchantHistory(userId, query)).toMatchObject({
      regret_rate: null,
      override_rate: null,
    });
  });

  it("throws on a database error or a malformed result", async () => {
    await expect(new SupabaseHistoryRepository(client({ error: { message: "boom" } }).client).merchantHistory(userId, query))
      .rejects.toThrow("Unable to load the merchant history.");
    await expect(new SupabaseHistoryRepository(client({ data: { purchases: "3" } }).client).merchantHistory(userId, query))
      .rejects.toThrow("Unexpected result from merchant_history.");
  });
});
