import type {
  Budget,
  CreateBudget,
  CreateRule,
  Rule,
  UpdateBudget,
  UpdateRule,
} from "@auxo/shared";
import { randomUUID } from "node:crypto";

export interface SettingsRepository {
  listRules(userId: string): Promise<Rule[]>;
  createRule(userId: string, input: CreateRule): Promise<Rule>;
  updateRule(userId: string, ruleId: string, input: UpdateRule): Promise<Rule | null>;
  deleteRule(userId: string, ruleId: string): Promise<boolean>;
  listBudgets(userId: string): Promise<Budget[]>;
  createBudget(userId: string, input: CreateBudget): Promise<Budget>;
  updateBudget(userId: string, budgetId: string, input: UpdateBudget): Promise<Budget | null>;
  deleteBudget(userId: string, budgetId: string): Promise<boolean>;
}

export interface PurchaseSpend {
  currency: string;
  amountMinor: number;
  // YYYY-MM-DD (UTC) of the purchase; budgets whose period contains it are charged.
  occurredOn: string;
}

// Adds a purchase to the user's matching budgets. The Supabase version of this
// lives in the record_decision_event database function, so that the event
// insert and the increment happen in one transaction.
export interface SpendLedger {
  recordSpend(userId: string, spend: PurchaseSpend): Promise<void>;
}

export class InMemorySettingsRepository implements SettingsRepository, SpendLedger {
  private readonly rules = new Map<string, { userId: string; value: Rule }>();
  private readonly budgets = new Map<string, { userId: string; value: Budget }>();

  public async listRules(userId: string): Promise<Rule[]> {
    return [...this.rules.values()].filter((row) => row.userId === userId).map((row) => row.value);
  }

  public async createRule(userId: string, input: CreateRule): Promise<Rule> {
    const now = new Date().toISOString();
    const value = { id: randomUUID(), ...input, created_at: now, updated_at: now };
    this.rules.set(value.id, { userId, value });
    return value;
  }

  public async updateRule(userId: string, ruleId: string, input: UpdateRule): Promise<Rule | null> {
    const row = this.rules.get(ruleId);
    if (!row || row.userId !== userId) return null;
    const changes = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as Partial<Rule>;
    row.value = { ...row.value, ...changes, updated_at: new Date().toISOString() };
    return row.value;
  }

  public async deleteRule(userId: string, ruleId: string): Promise<boolean> {
    const row = this.rules.get(ruleId);
    return !!row && row.userId === userId && this.rules.delete(ruleId);
  }

  public async listBudgets(userId: string): Promise<Budget[]> {
    return [...this.budgets.values()].filter((row) => row.userId === userId).map((row) => row.value);
  }

  public async createBudget(userId: string, input: CreateBudget): Promise<Budget> {
    const now = new Date().toISOString();
    const value = {
      id: randomUUID(),
      ...input,
      spent_minor: 0,
      created_at: now,
      updated_at: now,
    };
    this.budgets.set(value.id, { userId, value });
    return value;
  }

  public async updateBudget(
    userId: string,
    budgetId: string,
    input: UpdateBudget,
  ): Promise<Budget | null> {
    const row = this.budgets.get(budgetId);
    if (!row || row.userId !== userId) return null;
    const changes = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as Partial<Budget>;
    row.value = { ...row.value, ...changes, updated_at: new Date().toISOString() };
    return row.value;
  }

  public async deleteBudget(userId: string, budgetId: string): Promise<boolean> {
    const row = this.budgets.get(budgetId);
    return !!row && row.userId === userId && this.budgets.delete(budgetId);
  }

  public async recordSpend(userId: string, spend: PurchaseSpend): Promise<void> {
    for (const row of this.budgets.values()) {
      if (
        row.userId === userId &&
        row.value.currency === spend.currency &&
        row.value.period_start <= spend.occurredOn &&
        row.value.period_end >= spend.occurredOn
      ) {
        row.value = {
          ...row.value,
          spent_minor: row.value.spent_minor + spend.amountMinor,
          updated_at: new Date().toISOString(),
        };
      }
    }
  }
}
