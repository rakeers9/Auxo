import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Budget, Cart, Lane, Rule } from "@auxo/shared";
import { evaluatePolicy } from "../apps/api/src/services/policy-engine.js";

interface Scenario {
  id: string;
  repeat: number;
  cart: Omit<Cart, "cart_hash">;
  expectedLane: Lane;
  rule?: { name: string; rule_type: string; configuration: Record<string, unknown> };
  budget?: { limit_minor: number; spent_minor: number };
}

const file = fileURLToPath(new URL("./carts.jsonl", import.meta.url));
const scenarios = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Scenario);
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
      ? [{ id: randomUUID(), ...scenario.rule, enabled: true, created_at: now, updated_at: now }]
      : [];
    const budgets: Budget[] = scenario.budget
      ? [{ id: randomUUID(), currency: cart.currency, ...scenario.budget, period_start: "2026-10-01", period_end: "2026-10-31", created_at: now, updated_at: now }]
      : [];
    const actual = evaluatePolicy({ cart, rules, budgets, now: new Date(now) });
    total += 1;
    if (actual === scenario.expectedLane) correct += 1;
    confusion[`${scenario.expectedLane}->${actual}`] = (confusion[`${scenario.expectedLane}->${actual}`] ?? 0) + 1;
  }
}

const accuracy = total === 0 ? 0 : correct / total;
console.log(JSON.stringify({ total, correct, accuracy, confusion }, null, 2));
if (accuracy < 0.95) process.exitCode = 1;
