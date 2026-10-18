import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Budget, Cart, Lane, Rule, TriggerIntent } from "@auxo/shared";
import { InMemoryDecisionRepository } from "../apps/api/src/repositories/decision-repository.js";
import { InMemorySettingsRepository } from "../apps/api/src/repositories/settings-repository.js";
import { DecisionService } from "../apps/api/src/services/decision-service.js";
import { evaluatePolicy } from "../apps/api/src/services/policy-engine.js";

// Serves one scenario's rules and budgets to the decision service.
class ScenarioSettingsRepository extends InMemorySettingsRepository {
  public constructor(
    private readonly rules: Rule[],
    private readonly budgets: Budget[],
  ) {
    super();
  }

  public override async listRules(): Promise<Rule[]> {
    return this.rules;
  }

  public override async listBudgets(): Promise<Budget[]> {
    return this.budgets;
  }
}

interface Scenario {
  id: string;
  repeat: number;
  cart: Omit<Cart, "cart_hash">;
  expectedLane: Lane;
  rule?: { name: string; rule_type: string; configuration: Record<string, unknown> };
  budget?: { limit_minor: number; spent_minor: number };
  // When set, the case runs through DecisionService with this trigger intent
  // (e.g. a reducing cart edit), not the bare policy engine. Give such cases a
  // rule or budget so the hash-based stub never decides them.
  trigger?: TriggerIntent;
}

const file = fileURLToPath(new URL("./carts.jsonl", import.meta.url));
const scenarios = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Scenario);
// Not top-level await: tsx runs this file as CommonJS (the root package has no "type").
async function main(): Promise<void> {
  const confusion: Record<string, number> = {};
  let correct = 0;
  let total = 0;

  for (const scenario of scenarios) {
    for (let index = 0; index < scenario.repeat; index += 1) {
      const now = "2026-10-04T12:00:00.000Z";
      const cart: Cart = {
        ...scenario.cart,
        merchant: `${scenario.cart.merchant} ${index + 1}`,
        cart_hash: createHash("sha256").update(`${scenario.id}:${index}`).digest("hex"),
      };
      const rules: Rule[] = scenario.rule
        ? [{ id: randomUUID(), ...scenario.rule, rule_type: scenario.rule.rule_type as Rule["rule_type"], enabled: true, created_at: now, updated_at: now }]
        : [];
      const budgets: Budget[] = scenario.budget
        ? [{ id: randomUUID(), currency: cart.currency, ...scenario.budget, period_start: "2026-10-01", period_end: "2026-10-31", created_at: now, updated_at: now }]
        : [];
      const actual = scenario.trigger
        ? (
            await new DecisionService({
              repository: new InMemoryDecisionRepository(),
              settingsRepository: new ScenarioSettingsRepository(rules, budgets),
              ttlSeconds: 60,
              now: () => new Date(now),
            }).decide("eval-user", cart, { intent: scenario.trigger, source: "known", page_type: "cart", occurred_at: now })
          ).lane
        : evaluatePolicy({ cart, rules, budgets, now: new Date(now) });
      total += 1;
      if (actual === scenario.expectedLane) correct += 1;
      confusion[`${scenario.expectedLane}->${actual}`] = (confusion[`${scenario.expectedLane}->${actual}`] ?? 0) + 1;
    }
  }

  const accuracy = total === 0 ? 0 : correct / total;
  console.log(JSON.stringify({ total, correct, accuracy, confusion }, null, 2));
  if (accuracy < 0.95) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
