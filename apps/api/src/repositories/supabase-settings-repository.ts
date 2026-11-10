import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  BudgetSchema,
  RuleSchema,
  type Budget,
  type CreateBudget,
  type CreateRule,
  type Rule,
  type UpdateBudget,
  type UpdateRule,
} from "@auxo/shared";

import { budgetOn, stopRepeating, utcDate, type StoredBudget } from "../services/budget-period.js";
import type { SettingsRepository } from "./settings-repository.js";

const ruleColumns = "id,name,rule_type,configuration,enabled,created_at,updated_at";
const budgetColumns = "id,currency,limit_minor,spent_minor,spent_period_start,period_start,period_end,repeats,created_at,updated_at";

// A budgets row as stored: the booked period, not the current cycle.
const StoredBudgetSchema = BudgetSchema.omit({ period_days: true }).extend({
  spent_period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});

export interface InvalidSettingsRow {
  table: "rules" | "budgets";
  id: unknown;
  issues: string[];
}

export type InvalidSettingsRowLogger = (entry: InvalidSettingsRow) => void;

const defaultLogger: InvalidSettingsRowLogger = (entry) => {
  console.warn("Skipped an invalid settings row", entry);
};

export type ParseResult<T> = { success: true; data: T } | { success: false; issues: string[] };

// Rows are parsed with the shared zod schemas instead of cast. A listed row
// that fails to parse is skipped and logged, so one bad row can't break
// /v1/decide; a row this repository just wrote that fails to parse is an error.
export class SupabaseSettingsRepository implements SettingsRepository {
  public constructor(
    private readonly client: SupabaseClient,
    private readonly onInvalidRow: InvalidSettingsRowLogger = defaultLogger,
    // The clock that picks a repeating budget's current cycle.
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async listRules(userId: string): Promise<Rule[]> {
    const { data, error } = await this.client.from("rules").select(ruleColumns).eq("user_id", userId).order("created_at");
    if (error) throw new Error("Unable to list rules.", { cause: error });
    return this.parseRows("rules", data ?? [], parseRuleRow);
  }

  public async createRule(userId: string, input: CreateRule): Promise<Rule> {
    const { data, error } = await this.client.from("rules").insert({ user_id: userId, ...input }).select(ruleColumns).single();
    if (error) throw new Error("Unable to create rule.", { cause: error });
    return requireRow("rule", parseRuleRow(data));
  }

  public async updateRule(userId: string, ruleId: string, input: UpdateRule): Promise<Rule | null> {
    const { data, error } = await this.client.from("rules").update(input).eq("id", ruleId).eq("user_id", userId).select(ruleColumns).maybeSingle();
    if (error) throw new Error("Unable to update rule.", { cause: error });
    return data ? requireRow("rule", parseRuleRow(data)) : null;
  }

  public async deleteRule(userId: string, ruleId: string): Promise<boolean> {
    const { data, error } = await this.client.from("rules").delete().eq("id", ruleId).eq("user_id", userId).select("id").maybeSingle();
    if (error) throw new Error("Unable to delete rule.", { cause: error });
    return data !== null;
  }

  public async listBudgets(userId: string): Promise<Budget[]> {
    const { data, error } = await this.client.from("budgets").select(budgetColumns).eq("user_id", userId).order("period_start", { ascending: false });
    if (error) throw new Error("Unable to list budgets.", { cause: error });
    const today = utcDate(this.now());
    return this.parseRows("budgets", data ?? [], parseBudgetRow).map((stored) => budgetOn(stored, today));
  }

  public async createBudget(userId: string, input: CreateBudget): Promise<Budget> {
    const { data, error } = await this.client.from("budgets").insert({ user_id: userId, ...input }).select(budgetColumns).single();
    if (error) throw new Error("Unable to create budget.", { cause: error });
    return budgetOn(requireRow("budget", parseBudgetRow(data)), utcDate(this.now()));
  }

  // Turning `repeats` off reads the row first, to store its current cycle as
  // the budget's one remaining period.
  public async updateBudget(userId: string, budgetId: string, input: UpdateBudget): Promise<Budget | null> {
    const today = utcDate(this.now());
    let changes: Record<string, unknown> = { ...input };
    if (input.repeats === false) {
      const { data, error } = await this.client.from("budgets").select(budgetColumns).eq("id", budgetId).eq("user_id", userId).maybeSingle();
      if (error) throw new Error("Unable to update budget.", { cause: error });
      if (!data) return null;
      changes = { ...changes, ...stopRepeating(requireRow("budget", parseBudgetRow(data)), today) };
    }
    const { data, error } = await this.client.from("budgets").update(changes).eq("id", budgetId).eq("user_id", userId).select(budgetColumns).maybeSingle();
    if (error) throw new Error("Unable to update budget.", { cause: error });
    return data ? budgetOn(requireRow("budget", parseBudgetRow(data)), today) : null;
  }

  public async deleteBudget(userId: string, budgetId: string): Promise<boolean> {
    const { data, error } = await this.client.from("budgets").delete().eq("id", budgetId).eq("user_id", userId).select("id").maybeSingle();
    if (error) throw new Error("Unable to delete budget.", { cause: error });
    return data !== null;
  }

  private parseRows<T>(
    table: InvalidSettingsRow["table"],
    rows: unknown[],
    parse: (row: unknown) => ParseResult<T>,
  ): T[] {
    const values: T[] = [];
    for (const row of rows) {
      const result = parse(row);
      if (result.success) values.push(result.data);
      else this.onInvalidRow({ table, id: isRecord(row) ? row.id : undefined, issues: result.issues });
    }
    return values;
  }
}

// Postgres returns timestamptz as e.g. "2026-10-01T12:00:00.123456+00:00", which
// the contracts' z.string().datetime() rejects (it allows no offset), and
// bigint columns may come back as strings. Normalize both before parsing.
export function parseRuleRow(row: unknown): ParseResult<Rule> {
  if (!isRecord(row)) return { success: false, issues: ["(row): not an object"] };
  const parsed = RuleSchema.safeParse({
    ...row,
    created_at: isoTimestamp(row.created_at),
    updated_at: isoTimestamp(row.updated_at),
  });
  return parsed.success ? { success: true, data: parsed.data } : { success: false, issues: describeIssues(parsed.error.issues) };
}

export function parseBudgetRow(row: unknown): ParseResult<StoredBudget> {
  if (!isRecord(row)) return { success: false, issues: ["(row): not an object"] };
  const parsed = StoredBudgetSchema.safeParse({
    ...row,
    limit_minor: integer(row.limit_minor),
    spent_minor: integer(row.spent_minor),
    created_at: isoTimestamp(row.created_at),
    updated_at: isoTimestamp(row.updated_at),
  });
  return parsed.success ? { success: true, data: parsed.data } : { success: false, issues: describeIssues(parsed.error.issues) };
}

function describeIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string[] {
  return issues.map((issue) => `${issue.path.map(String).join(".") || "(row)"}: ${issue.message}`);
}

function requireRow<T>(kind: string, result: ParseResult<T>): T {
  if (result.success) return result.data;
  throw new Error(`The stored ${kind} is invalid: ${result.issues.join("; ")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isoTimestamp(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toISOString();
}

function integer(value: unknown): unknown {
  return typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
}
