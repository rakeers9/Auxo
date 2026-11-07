import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Budget, Cart, DecisionHistory, Lane, Rule, TriggerIntent } from "@auxo/shared";
import { InMemoryDecisionRepository } from "../apps/api/src/repositories/decision-repository.js";
import { InMemorySettingsRepository } from "../apps/api/src/repositories/settings-repository.js";
import type { HistoryRepository } from "../apps/api/src/repositories/history-repository.js";
import { CloudflareClefProvider } from "../apps/api/src/services/decision-model-provider.js";
import { DecisionService } from "../apps/api/src/services/decision-service.js";

// Scores the real decision model (Cloudflare Clef) on hand-labelled carts.
// Each case lists the lanes a person would accept; a decision inside that
// range counts as right, below it as too lenient, above it as too strict.
// Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN; makes one Clef call
// per case. Run with `pnpm eval:model`.

interface Case {
  id: string;
  cart: Omit<Cart, "cart_hash" | "url">;
  time_zone: string;
  at: string;
  trigger: TriggerIntent;
  budget?: { limit_minor: number; spent_minor: number };
  history?: DecisionHistory;
  rule?: { description: string };
  lanes: [Lane, Lane];
}

const RANK: Record<Lane, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };

class CaseSettings extends InMemorySettingsRepository {
  public constructor(private readonly rules: Rule[], private readonly budgets: Budget[]) {
    super();
  }
  public override async listRules(): Promise<Rule[]> {
    return this.rules;
  }
  public override async listBudgets(): Promise<Budget[]> {
    return this.budgets;
  }
}

async function main(): Promise<void> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to score the decision model.");
    process.exitCode = 1;
    return;
  }
  const model = process.env.CLEF_MODEL === "clef-flash" ? "clef-flash" : "clef";
  const provider = new CloudflareClefProvider({ accountId, apiToken, model, timeoutMs: 10_000 });
  const file = fileURLToPath(new URL("./model-carts.jsonl", import.meta.url));
  const cases = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Case);

  const results: Array<{ id: string; lane: Lane; expected: string; verdict: string; impulse?: number; want?: number }> = [];
  let modelErrors = 0;
  for (const scenario of cases) {
    const now = scenario.at;
    const cart: Cart = {
      ...scenario.cart,
      url: `https://${scenario.cart.merchant}/cart`,
      cart_hash: createHash("sha256").update(scenario.id).digest("hex"),
    };
    const rules: Rule[] = scenario.rule
      ? [{ id: randomUUID(), name: "Rule", rule_type: "description", configuration: scenario.rule, enabled: true, created_at: now, updated_at: now }]
      : [];
    const budgets: Budget[] = scenario.budget
      ? [{ id: randomUUID(), currency: cart.currency, ...scenario.budget, period_start: now.slice(0, 8) + "01", period_end: now.slice(0, 8) + "28", created_at: now, updated_at: now }]
      : [];
    const history = scenario.history;
    const historyRepository: HistoryRepository | undefined = history ? { merchantHistory: async () => history } : undefined;
    const service = new DecisionService({
      repository: new InMemoryDecisionRepository(),
      settingsRepository: new CaseSettings(rules, budgets),
      decisionModelProvider: provider,
      onDecisionModelError: (error) => {
        modelErrors += 1;
        console.error(`${scenario.id}: model error`, error);
      },
      ...(historyRepository ? { historyRepository, historyTimeoutMs: 1_000 } : {}),
      ttlSeconds: 60,
      now: () => new Date(now),
    });
    const decision = await service.decide(
      "eval-user",
      cart,
      { intent: scenario.trigger, source: "known", page_type: "checkout", occurred_at: now },
      scenario.time_zone,
    );
    const [low, high] = scenario.lanes;
    const verdict = RANK[decision.lane] < RANK[low] ? "too_lenient" : RANK[decision.lane] > RANK[high] ? "too_strict" : "ok";
    const signals = decision.context.model_signal?.signals;
    results.push({
      id: scenario.id,
      lane: decision.lane,
      expected: `${low}-${high}`,
      verdict,
      ...(signals?.impulse !== undefined ? { impulse: signals.impulse } : {}),
      ...(signals?.want !== undefined ? { want: signals.want } : {}),
    });
  }

  const ok = results.filter((result) => result.verdict === "ok").length;
  console.table(results);
  console.log(JSON.stringify({
    model,
    total: results.length,
    in_range: ok,
    too_lenient: results.filter((result) => result.verdict === "too_lenient").length,
    too_strict: results.filter((result) => result.verdict === "too_strict").length,
    model_errors: modelErrors,
    accuracy: results.length === 0 ? 0 : ok / results.length,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
