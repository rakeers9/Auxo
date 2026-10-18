import type { Cart, CheckIn, DecisionEvent, DecisionHistory, Verdict } from "@auxo/shared";

import type { DecisionRecord } from "./decision-repository.js";

// AUX-34: the user's recent history at a merchant, read into /v1/decide.
export const HISTORY_WINDOW_DAYS = 30;

export interface HistoryQuery {
  merchant: string;
  // spent_minor only sums purchases in this currency (the current cart's).
  currency: string;
  // The window is [now - windowDays, now], both ends inclusive.
  now: Date;
  windowDays: number;
}

export interface HistoryRepository {
  merchantHistory(userId: string, query: HistoryQuery): Promise<DecisionHistory>;
}

export interface HistoryDecision {
  id: string;
  userId: string;
  cart: Pick<Cart, "merchant" | "currency" | "total_minor">;
  action: Verdict["action"];
  createdAt: string;
}

export interface HistoryInput {
  decisions: HistoryDecision[];
  events: Array<{ userId: string; event: DecisionEvent }>;
  checkIns: Array<{ userId: string; checkIn: CheckIn }>;
}

// The one definition of the history numbers; the SQL function
// merchant_history (migration 202610180003) computes the same thing.
//
// - purchases: `bought` events in the window whose decision's cart merchant
//   matches (case-insensitive).
// - spent_minor: those purchases' cart totals, in query.currency only.
// - check_ins / regret_rate: check-ins answered in the window on decisions at
//   the merchant, and the share answered "regret" (null with none).
// - override_rate: of the user's paused or blocked decisions at the merchant
//   created in the window, the share with an `overrode` event (null with none).
export function computeMerchantHistory(userId: string, query: HistoryQuery, input: HistoryInput): DecisionHistory {
  const until = query.now.getTime();
  const since = until - query.windowDays * 86_400_000;
  const inWindow = (timestamp: string) => {
    const time = Date.parse(timestamp);
    return time >= since && time <= until;
  };
  const merchant = query.merchant.toLowerCase();
  const atMerchant = new Map(
    input.decisions
      .filter((decision) => decision.userId === userId && decision.cart.merchant.toLowerCase() === merchant)
      .map((decision) => [decision.id, decision]),
  );
  const events = input.events.filter((row) => row.userId === userId && atMerchant.has(row.event.decision_id));

  let purchases = 0;
  let spentMinor = 0;
  for (const { event } of events) {
    if (event.action !== "bought" || !inWindow(event.occurred_at)) continue;
    purchases += 1;
    const decision = atMerchant.get(event.decision_id);
    if (decision && decision.cart.currency === query.currency) spentMinor += decision.cart.total_minor;
  }

  const checkIns = input.checkIns.filter(
    (row) => row.userId === userId && atMerchant.has(row.checkIn.decision_id) && inWindow(row.checkIn.answered_at),
  );
  const regrets = checkIns.filter((row) => row.checkIn.worth_it === "regret").length;

  const overridden = new Set(events.filter((row) => row.event.action === "overrode").map((row) => row.event.decision_id));
  const guarded = [...atMerchant.values()].filter(
    (decision) => decision.action !== "allow" && inWindow(decision.createdAt),
  );
  const overrides = guarded.filter((decision) => overridden.has(decision.id)).length;

  return {
    merchant: query.merchant,
    window_days: query.windowDays,
    purchases,
    spent_minor: spentMinor,
    check_ins: checkIns.length,
    regret_rate: checkIns.length > 0 ? regrets / checkIns.length : null,
    override_rate: guarded.length > 0 ? overrides / guarded.length : null,
  };
}

export interface InMemoryHistoryRepositoryOptions {
  // The same in-memory repositories /v1/decide, /v1/events and /v1/check-ins write to.
  decisions: { list(): DecisionRecord[] };
  outcomes: {
    listEvents(): Array<{ userId: string; event: DecisionEvent }>;
    listCheckIns(): Array<{ userId: string; checkIn: CheckIn }>;
  };
}

export class InMemoryHistoryRepository implements HistoryRepository {
  public constructor(private readonly options: InMemoryHistoryRepositoryOptions) {}

  public async merchantHistory(userId: string, query: HistoryQuery): Promise<DecisionHistory> {
    return computeMerchantHistory(userId, query, {
      decisions: this.options.decisions.list().map((record) => ({
        id: record.verdict.decision_id,
        userId: record.userId,
        cart: record.cart,
        action: record.verdict.action,
        createdAt: record.createdAt,
      })),
      events: this.options.outcomes.listEvents(),
      checkIns: this.options.outcomes.listCheckIns(),
    });
  }
}
