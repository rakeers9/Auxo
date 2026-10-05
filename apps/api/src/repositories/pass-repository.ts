import { randomUUID } from "node:crypto";

import type { Pass } from "@auxo/shared";

export interface CreatePassRecord {
  userId: string;
  decisionId: string;
  cartHash: string;
  merchant: string;
  issuedAt: string;
  expiresAt: string;
}

export interface PassRepository {
  create(record: CreatePassRecord): Promise<Pass>;
  findActive(userId: string, cartHash: string, now: Date): Promise<Pass | null>;
}

export class InMemoryPassRepository implements PassRepository {
  private readonly passes = new Map<string, { userId: string; value: Pass }>();

  public async create(record: CreatePassRecord): Promise<Pass> {
    const existing = [...this.passes.values()].find((row) => row.userId === record.userId && row.value.decision_id === record.decisionId);
    if (existing) return existing.value;
    const value: Pass = {
      pass_id: randomUUID(),
      decision_id: record.decisionId,
      cart_hash: record.cartHash,
      merchant: record.merchant,
      expires_at: record.expiresAt,
    };
    this.passes.set(value.pass_id, { userId: record.userId, value });
    return value;
  }

  public async findActive(userId: string, cartHash: string, now: Date): Promise<Pass | null> {
    return [...this.passes.values()].find((row) =>
      row.userId === userId && row.value.cart_hash.toLowerCase() === cartHash.toLowerCase() && new Date(row.value.expires_at) > now,
    )?.value ?? null;
  }
}
