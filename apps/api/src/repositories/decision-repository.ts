import type { Cart, DecisionContext, Verdict } from "@auxo/shared";

export interface DecisionRecord {
  userId: string;
  cart: Cart;
  verdict: Verdict;
  policyVersion: string;
  modelProvider: "stub" | "policy-engine" | "cloudflare-clef" | "model-fallback";
  modelVersion: string;
  modelOutput?: unknown;
  context: DecisionContext;
  expiresAt: string;
  createdAt: string;
}

export interface OwnedDecision {
  cart: Cart;
  verdict: Verdict;
  createdAt: string;
}

export interface DecisionRepository {
  belongsToUser(userId: string, decisionId: string): Promise<boolean>;
  findOwned(userId: string, decisionId: string): Promise<OwnedDecision | null>;
  save(record: DecisionRecord): Promise<void>;
}

export class InMemoryDecisionRepository implements DecisionRepository {
  // Keyed by decision_id: every request is its own decision.
  private readonly records = new Map<string, DecisionRecord>();

  public async save(record: DecisionRecord): Promise<void> {
    this.records.set(record.verdict.decision_id, record);
  }

  public async belongsToUser(userId: string, decisionId: string): Promise<boolean> {
    return this.records.get(decisionId)?.userId === userId;
  }

  public list(): DecisionRecord[] {
    return [...this.records.values()];
  }

  public async findOwned(userId: string, decisionId: string): Promise<OwnedDecision | null> {
    const record = this.records.get(decisionId);
    return record && record.userId === userId ? { cart: record.cart, verdict: record.verdict, createdAt: record.createdAt } : null;
  }
}
