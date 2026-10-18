import { describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { SupabaseDecisionRepository } from "./supabase-decision-repository.js";
import { SupabaseOutcomeRepository } from "./supabase-outcome-repository.js";
import { SupabasePassRepository } from "./supabase-pass-repository.js";
import { SupabaseSettingsRepository, parseBudgetRow, parseRuleRow } from "./supabase-settings-repository.js";

// Unit tests for the Supabase repositories against a scripted client.
//
// A scripted stand-in for the supabase-js query builder, for repository unit
// tests. Every chained call is recorded; each terminal call (single,
// maybeSingle, awaiting the builder, or rpc) takes the next scripted response.

interface FakeResponse {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
}

interface FakeCall {
  target: string;
  ops: Array<[string, unknown[]]>;
}

function fakeSupabase(responses: FakeResponse[]) {
  const queue = [...responses];
  const calls: FakeCall[] = [];
  const next = () => {
    const response = queue.shift() ?? {};
    return { data: response.data ?? null, error: response.error ?? null };
  };

  const builder = (call: FakeCall): unknown => {
    const proxy: unknown = new Proxy({}, {
      get(_target, property) {
        if (property === "then") {
          return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(next()).then(resolve, reject);
        }
        const name = String(property);
        if (name === "single" || name === "maybeSingle") {
          return () => {
            call.ops.push([name, []]);
            return Promise.resolve(next());
          };
        }
        return (...args: unknown[]) => {
          call.ops.push([name, args]);
          return proxy;
        };
      },
    });
    return proxy;
  };

  const client = {
    from(table: string) {
      const call: FakeCall = { target: table, ops: [] };
      calls.push(call);
      return builder(call);
    },
    rpc(name: string, args: unknown) {
      calls.push({ target: `rpc:${name}`, ops: [["rpc", [args]]] });
      return Promise.resolve(next());
    },
  };

  return { client: client as unknown as SupabaseClient, calls, remaining: () => queue.length };
}

function opsOf(call: FakeCall | undefined, name: string): unknown[][] {
  return (call?.ops ?? []).filter(([op]) => op === name).map(([, args]) => args);
}

const userId = "20000000-0000-4000-8000-000000000001";
const decisionId = "10000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64);
const passRow = (id: string, expiresAt: string) => ({
  id,
  decision_id: decisionId,
  cart_hash: hash,
  merchant: "Example Store",
  expires_at: expiresAt,
});
const issueRecord = {
  userId,
  decisionId,
  cartHash: hash.toUpperCase(),
  merchant: "Example Store",
  issuedAt: "2030-01-01T00:10:00.000Z",
  expiresAt: "2030-01-01T00:20:00.000Z",
};

describe("SupabasePassRepository", () => {
  it("returns the decision's active pass without inserting", async () => {
    const { client, calls } = fakeSupabase([{ data: passRow("30000000-0000-4000-8000-000000000001", "2030-01-01T00:15:00+00:00") }]);

    const pass = await new SupabasePassRepository(client).issue(issueRecord);

    expect(pass.pass_id).toBe("30000000-0000-4000-8000-000000000001");
    expect(pass.expires_at).toBe("2030-01-01T00:15:00.000Z");
    expect(calls).toHaveLength(1);
    expect(opsOf(calls[0], "is")).toEqual([["revoked_at", null]]);
    expect(opsOf(calls[0], "gt")).toEqual([["expires_at", issueRecord.issuedAt]]);
  });

  it("retires expired passes, then inserts a lowercase pass", async () => {
    const { client, calls } = fakeSupabase([
      { data: null },
      {},
      { data: passRow("30000000-0000-4000-8000-000000000002", issueRecord.expiresAt) },
    ]);

    const pass = await new SupabasePassRepository(client).issue(issueRecord);

    expect(pass.pass_id).toBe("30000000-0000-4000-8000-000000000002");
    expect(opsOf(calls[1], "update")).toEqual([[{ revoked_at: issueRecord.issuedAt }]]);
    expect(opsOf(calls[1], "lte")).toEqual([["expires_at", issueRecord.issuedAt]]);
    expect(opsOf(calls[1], "is")).toEqual([["revoked_at", null]]);
    expect(opsOf(calls[2], "insert")[0]?.[0]).toMatchObject({ cart_hash: hash, decision_id: decisionId });
  });

  it("returns the winner when a concurrent insert wins the race (23505)", async () => {
    const { client, remaining } = fakeSupabase([
      { data: null },
      {},
      { error: { code: "23505", message: "duplicate key" } },
      { data: passRow("30000000-0000-4000-8000-000000000003", issueRecord.expiresAt) },
    ]);

    const pass = await new SupabasePassRepository(client).issue(issueRecord);

    expect(pass.pass_id).toBe("30000000-0000-4000-8000-000000000003");
    expect(remaining()).toBe(0);
  });

  it("throws on other insert errors", async () => {
    const { client } = fakeSupabase([{ data: null }, {}, { error: { code: "23503", message: "fk" } }]);

    await expect(new SupabasePassRepository(client).issue(issueRecord)).rejects.toThrow("Unable to issue the pass.");
  });

  it("looks up the active pass by the lowercased hash", async () => {
    const { client, calls } = fakeSupabase([{ data: passRow("30000000-0000-4000-8000-000000000001", "2030-01-01T00:15:00+00:00") }]);

    const pass = await new SupabasePassRepository(client).findActive(userId, `SHA256:${hash.toUpperCase()}`, new Date("2030-01-01T00:10:00.000Z"));

    expect(pass?.cart_hash).toBe(hash);
    expect(opsOf(calls[0], "eq")).toContainEqual(["cart_hash", `sha256:${hash}`]);
    expect(opsOf(calls[0], "gt")).toEqual([["expires_at", "2030-01-01T00:10:00.000Z"]]);
  });
});

describe("SupabaseDecisionRepository.findOwned", () => {
  const row = {
    id: decisionId,
    cart: { merchant: "Example Store", items: [{ name: "Shoes", price_minor: 100, qty: 1 }], total_minor: 100, currency: "USD", url: "https://example.com/cart", cart_hash: hash.toUpperCase() },
    lane: "L3",
    action: "block",
    template_id: "l3-block",
    cooldown_seconds: 300,
    created_at: "2030-01-01T00:00:00.123456+00:00",
    expires_at: "2030-01-02T00:00:00+00:00",
  };

  it("parses the row, including expires_at and a lowercased cart hash", async () => {
    const { client, calls } = fakeSupabase([{ data: row }]);

    const decision = await new SupabaseDecisionRepository(client).findOwned(userId, decisionId);

    expect(decision).toEqual({
      cart: { ...row.cart, cart_hash: hash },
      verdict: { decision_id: decisionId, lane: "L3", action: "block", template_id: "l3-block", cooldown_seconds: 300 },
      createdAt: "2030-01-01T00:00:00.123Z",
      expiresAt: "2030-01-02T00:00:00.000Z",
    });
    expect(opsOf(calls[0], "select")[0]?.[0]).toContain("expires_at");
  });

  it("returns null for a missing row and throws for an invalid one", async () => {
    expect(await new SupabaseDecisionRepository(fakeSupabase([{ data: null }]).client).findOwned(userId, decisionId)).toBeNull();
    await expect(
      new SupabaseDecisionRepository(fakeSupabase([{ data: { ...row, cart: { merchant: "x" } } }]).client).findOwned(userId, decisionId),
    ).rejects.toThrow("The stored decision is invalid.");
  });
});

describe("SupabaseOutcomeRepository.saveEvent", () => {
  const event = {
    event_id: "40000000-0000-4000-8000-000000000001",
    decision_id: decisionId,
    action: "bought" as const,
    occurred_at: "2030-01-01T00:00:00.000Z",
  };

  it("records the event through record_decision_event", async () => {
    const { client, calls } = fakeSupabase([{ data: "created" }, { data: "duplicate" }]);
    const repository = new SupabaseOutcomeRepository(client);

    expect(await repository.saveEvent(userId, event)).toBe("created");
    expect(await repository.saveEvent(userId, event)).toBe("duplicate");
    expect(calls[0]).toEqual({
      target: "rpc:record_decision_event",
      ops: [["rpc", [{
        p_event_id: event.event_id,
        p_user_id: userId,
        p_decision_id: decisionId,
        p_event_type: "bought",
        p_occurred_at: event.occurred_at,
        p_metadata: {},
      }]]],
    });
  });

  it("throws on an error or an unexpected result", async () => {
    await expect(new SupabaseOutcomeRepository(fakeSupabase([{ error: { message: "boom" } }]).client).saveEvent(userId, event))
      .rejects.toThrow("Unable to persist the decision event.");
    await expect(new SupabaseOutcomeRepository(fakeSupabase([{ data: "other" }]).client).saveEvent(userId, event))
      .rejects.toThrow("Unexpected result");
  });
});

describe("SupabaseSettingsRepository", () => {
  const budgetRow = {
    id: "50000000-0000-4000-8000-000000000001",
    currency: "USD",
    limit_minor: "10000",
    spent_minor: 2500,
    period_start: "2026-10-01",
    period_end: "2026-10-31",
    created_at: "2026-10-01T12:00:00.123456+00:00",
    updated_at: "2026-10-02T12:00:00+00:00",
  };
  const ruleRow = {
    id: "60000000-0000-4000-8000-000000000001",
    name: "Big carts",
    rule_type: "cart_total",
    configuration: { lane: "L2", threshold_minor: 5000 },
    enabled: true,
    created_at: "2026-10-01T12:00:00+00:00",
    updated_at: "2026-10-01T12:00:00+00:00",
  };

  it("parses Postgres-shaped budget and rule rows", () => {
    expect(parseBudgetRow(budgetRow)).toEqual({
      success: true,
      data: { ...budgetRow, limit_minor: 10_000, created_at: "2026-10-01T12:00:00.123Z", updated_at: "2026-10-02T12:00:00.000Z" },
    });
    expect(parseRuleRow(ruleRow)).toMatchObject({ success: true, data: { rule_type: "cart_total", created_at: "2026-10-01T12:00:00.000Z" } });
  });

  it("skips and logs listed rows that fail to parse", async () => {
    const onInvalidRow = vi.fn();
    const badBudget = { ...budgetRow, id: "50000000-0000-4000-8000-000000000002", currency: "usd" };
    const badRule = { ...ruleRow, id: "60000000-0000-4000-8000-000000000002", rule_type: "mystery" };
    const { client } = fakeSupabase([{ data: [budgetRow, badBudget] }, { data: [badRule, ruleRow] }]);
    const repository = new SupabaseSettingsRepository(client, onInvalidRow);

    expect((await repository.listBudgets(userId)).map((budget) => budget.id)).toEqual([budgetRow.id]);
    expect((await repository.listRules(userId)).map((rule) => rule.id)).toEqual([ruleRow.id]);
    expect(onInvalidRow).toHaveBeenCalledTimes(2);
    expect(onInvalidRow).toHaveBeenCalledWith({ table: "budgets", id: badBudget.id, issues: [expect.stringContaining("currency")] });
    expect(onInvalidRow).toHaveBeenCalledWith({ table: "rules", id: badRule.id, issues: [expect.stringContaining("rule_type")] });
  });

  it("throws when a row it just wrote fails to parse", async () => {
    const { client } = fakeSupabase([{ data: { ...budgetRow, spent_minor: -1 } }]);

    await expect(new SupabaseSettingsRepository(client, vi.fn()).createBudget(userId, {
      currency: "USD",
      limit_minor: 10_000,
      period_start: "2026-10-01",
      period_end: "2026-10-31",
    })).rejects.toThrow("The stored budget is invalid");
  });
});
