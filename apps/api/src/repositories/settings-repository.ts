import type {
  Budget,
  CreateBudget,
  CreateRule,
  Rule,
  UpdateBudget,
  UpdateRule,
} from "@auxo/shared";
import { randomUUID } from "node:crypto";

import { budgetOn, chargeBudget, stopRepeating, utcDate, type StoredBudget } from "../services/budget-period.js";

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
  // YYYY-MM-DD (UTC) of the purchase. It's charged to the cycle of each
  // budget that contains it (see services/budget-period.ts).
  occurredOn: string;
}

// Adds a purchase to the user's matching budgets. The Supabase version of this
// lives in the record_decision_event database function, so that the event
// insert and the increment happen in one transaction.
export interface SpendLedger {
  recordSpend(userId: string, spend: PurchaseSpend): Promise<void>;
}

export interface InMemorySettingsRepositoryOptions {
  // The clock that picks a repeating budget's current cycle.
  now?: () => Date;
}

export class InMemorySettingsRepository implements SettingsRepository, SpendLedger {
  private readonly rules = new Map<string, { userId: string; value: Rule }>();
  private readonly budgets = new Map<string, { userId: string; value: StoredBudget }>();
  private readonly now: () => Date;

  public constructor(options: InMemorySettingsRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  private today(): string {
    return utcDate(this.now());
  }

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
    const today = this.today();
    return [...this.budgets.values()].filter((row) => row.userId === userId).map((row) => budgetOn(row.value, today));
  }

  public async createBudget(userId: string, input: CreateBudget): Promise<Budget> {
    const now = new Date().toISOString();
    const value: StoredBudget = {
      id: randomUUID(),
      currency: input.currency,
      limit_minor: input.limit_minor,
      spent_minor: 0,
      spent_period_start: null,
      period_start: input.period_start,
      period_end: input.period_end,
      repeats: input.repeats ?? false,
      created_at: now,
      updated_at: now,
    };
    this.budgets.set(value.id, { userId, value });
    return budgetOn(value, this.today());
  }

  public async updateBudget(
    userId: string,
    budgetId: string,
    input: UpdateBudget,
  ): Promise<Budget | null> {
    const row = this.budgets.get(budgetId);
    if (!row || row.userId !== userId) return null;
    const today = this.today();
    row.value = {
      ...row.value,
      ...(input.limit_minor !== undefined ? { limit_minor: input.limit_minor } : {}),
      ...(input.repeats === true ? { repeats: true } : {}),
      ...(input.repeats === false ? stopRepeating(row.value, today) : {}),
      updated_at: new Date().toISOString(),
    };
    return budgetOn(row.value, today);
  }

  public async deleteBudget(userId: string, budgetId: string): Promise<boolean> {
    const row = this.budgets.get(budgetId);
    return !!row && row.userId === userId && this.budgets.delete(budgetId);
  }

  public async recordSpend(userId: string, spend: PurchaseSpend): Promise<void> {
    for (const row of this.budgets.values()) {
      if (row.userId !== userId || row.value.currency !== spend.currency) continue;
      const charged = chargeBudget(row.value, spend.amountMinor, spend.occurredOn);
      if (charged) row.value = { ...row.value, ...charged, updated_at: new Date().toISOString() };
    }
  }
}
