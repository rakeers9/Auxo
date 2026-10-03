import type { Cart, Verdict } from "@auxo/shared";

export interface DecisionRecord {
  userId: string;
  cart: Cart;
  verdict: Verdict;
  policyVersion: string;
  expiresAt: string;
}

export interface DecisionRepository {
  findActive(
    userId: string,
    cartHash: string,
    policyVersion: string,
    now: Date,
  ): Promise<Verdict | null>;
  save(record: DecisionRecord): Promise<void>;
}

export class InMemoryDecisionRepository implements DecisionRepository {
  private readonly records = new Map<string, DecisionRecord>();

  public async findActive(
    userId: string,
    cartHash: string,
    policyVersion: string,
    now: Date,
  ): Promise<Verdict | null> {
    const record = this.records.get(this.key(userId, cartHash, policyVersion));

    if (!record || new Date(record.expiresAt) <= now) {
      return null;
    }

    return record.verdict;
  }

  public async save(record: DecisionRecord): Promise<void> {
    this.records.set(
      this.key(record.userId, record.cart.cart_hash, record.policyVersion),
      record,
    );
  }

  private key(userId: string, cartHash: string, policyVersion: string): string {
    return `${userId}:${cartHash.toLowerCase()}:${policyVersion}`;
  }
}
