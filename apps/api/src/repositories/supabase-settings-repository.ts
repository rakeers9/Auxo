import type { SupabaseClient } from "@supabase/supabase-js";
import type { Budget, CreateBudget, CreateRule, Rule, UpdateBudget, UpdateRule } from "@auxo/shared";
import type { SettingsRepository } from "./settings-repository.js";

const ruleColumns = "id,name,rule_type,configuration,enabled,created_at,updated_at";
const budgetColumns = "id,currency,limit_minor,spent_minor,period_start,period_end,created_at,updated_at";

export class SupabaseSettingsRepository implements SettingsRepository {
  public constructor(private readonly client: SupabaseClient) {}

  public async listRules(userId: string): Promise<Rule[]> {
    const { data, error } = await this.client.from("rules").select(ruleColumns).eq("user_id", userId).order("created_at");
    if (error) throw new Error("Unable to list rules.", { cause: error });
    return data as Rule[];
  }

  public async createRule(userId: string, input: CreateRule): Promise<Rule> {
    const { data, error } = await this.client.from("rules").insert({ user_id: userId, ...input }).select(ruleColumns).single();
    if (error) throw new Error("Unable to create rule.", { cause: error });
    return data as Rule;
  }

  public async updateRule(userId: string, ruleId: string, input: UpdateRule): Promise<Rule | null> {
    const { data, error } = await this.client.from("rules").update(input).eq("id", ruleId).eq("user_id", userId).select(ruleColumns).maybeSingle();
    if (error) throw new Error("Unable to update rule.", { cause: error });
    return data as Rule | null;
  }

  public async deleteRule(userId: string, ruleId: string): Promise<boolean> {
    const { data, error } = await this.client.from("rules").delete().eq("id", ruleId).eq("user_id", userId).select("id").maybeSingle();
    if (error) throw new Error("Unable to delete rule.", { cause: error });
    return data !== null;
  }

  public async listBudgets(userId: string): Promise<Budget[]> {
    const { data, error } = await this.client.from("budgets").select(budgetColumns).eq("user_id", userId).order("period_start", { ascending: false });
    if (error) throw new Error("Unable to list budgets.", { cause: error });
    return (data ?? []).map(normalizeBudget);
  }

  public async createBudget(userId: string, input: CreateBudget): Promise<Budget> {
    const { data, error } = await this.client.from("budgets").insert({ user_id: userId, ...input }).select(budgetColumns).single();
    if (error) throw new Error("Unable to create budget.", { cause: error });
    return normalizeBudget(data);
  }

  public async updateBudget(userId: string, budgetId: string, input: UpdateBudget): Promise<Budget | null> {
    const { data, error } = await this.client.from("budgets").update(input).eq("id", budgetId).eq("user_id", userId).select(budgetColumns).maybeSingle();
    if (error) throw new Error("Unable to update budget.", { cause: error });
    return data ? normalizeBudget(data) : null;
  }

  public async deleteBudget(userId: string, budgetId: string): Promise<boolean> {
    const { data, error } = await this.client.from("budgets").delete().eq("id", budgetId).eq("user_id", userId).select("id").maybeSingle();
    if (error) throw new Error("Unable to delete budget.", { cause: error });
    return data !== null;
  }
}

function normalizeBudget(row: Record<string, unknown>): Budget {
  return { ...row, limit_minor: Number(row.limit_minor), spent_minor: Number(row.spent_minor) } as Budget;
}
