import type { Cart, DecideResponse, DecisionContext, Verdict } from "@auxo/shared";

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
  findActive(
    userId: string,
    cartHash: string,
    policyVersion: string,
    now: Date,
  ): Promise<DecideResponse | null>;
  belongsToUser(userId: string, decisionId: string): Promise<boolean>;
  findOwned(userId: string, decisionId: string): Promise<OwnedDecision | null>;
  save(record: DecisionRecord): Promise<void>;
}

export class InMemoryDecisionRepository implements DecisionRepository {
  private readonly records = new Map<string, DecisionRecord>();

  public async findActive(
    userId: string,
    cartHash: string,
    policyVersion: string,
    now: Date,
  ): Promise<DecideResponse | null> {
    const record = this.records.get(this.key(userId, cartHash, policyVersion));

    if (!record || new Date(record.expiresAt) <= now) {
      return null;
    }

    return { ...record.verdict, context: record.context };
  }

  public async save(record: DecisionRecord): Promise<void> {
    this.records.set(
      this.key(record.userId, record.cart.cart_hash, record.policyVersion),
      record,
    );
  }

  public async belongsToUser(userId: string, decisionId: string): Promise<boolean> {
    return [...this.records.values()].some(
      (record) => record.userId === userId && record.verdict.decision_id === decisionId,
    );
  }

  public async findOwned(userId: string, decisionId: string): Promise<OwnedDecision | null> {
    const record = [...this.records.values()].find(
      (candidate) => candidate.userId === userId && candidate.verdict.decision_id === decisionId,
    );
    return record ? { cart: record.cart, verdict: record.verdict, createdAt: record.createdAt } : null;
  }

  private key(userId: string, cartHash: string, policyVersion: string): string {
    return `${userId}:${cartHash.toLowerCase()}:${policyVersion}`;
  }
}
