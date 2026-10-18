import { randomUUID } from "node:crypto";

import type { Pass } from "@auxo/shared";

export interface IssuePassRecord {
  userId: string;
  decisionId: string;
  cartHash: string;
  merchant: string;
  issuedAt: string;
  expiresAt: string;
}

export interface PassRepository {
  // Returns the decision's active pass (unexpired at `issuedAt`, unrevoked) if
  // there is one, otherwise retires the decision's expired passes and issues a
  // new one. Concurrent callers for the same decision get the same pass.
  issue(record: IssuePassRecord): Promise<Pass>;
  // `cartHash` is compared lowercase: the contract lowercases the query and
  // passes are stored lowercase.
  findActive(userId: string, cartHash: string, now: Date): Promise<Pass | null>;
}

interface StoredPass {
  userId: string;
  value: Pass;
  revokedAt: string | null;
}

export class InMemoryPassRepository implements PassRepository {
  private readonly passes = new Map<string, StoredPass>();

  public async issue(record: IssuePassRecord): Promise<Pass> {
    const now = new Date(record.issuedAt);
    const forDecision = [...this.passes.values()].filter(
      (row) => row.userId === record.userId && row.value.decision_id === record.decisionId && row.revokedAt === null,
    );
    const active = forDecision.find((row) => isActive(row, now));
    if (active) return active.value;

    // Same as the database: at most one unrevoked pass per decision, so the
    // expired one is retired before the new one is issued.
    for (const row of forDecision) row.revokedAt = record.issuedAt;
    const value: Pass = {
      pass_id: randomUUID(),
      decision_id: record.decisionId,
      cart_hash: record.cartHash.toLowerCase(),
      merchant: record.merchant,
      expires_at: record.expiresAt,
    };
    this.passes.set(value.pass_id, { userId: record.userId, value, revokedAt: null });
    return value;
  }

  public async findActive(userId: string, cartHash: string, now: Date): Promise<Pass | null> {
    const hash = cartHash.toLowerCase();
    return [...this.passes.values()]
      .filter((row) => row.userId === userId && row.value.cart_hash === hash && isActive(row, now))
      .sort((left, right) => Date.parse(right.value.expires_at) - Date.parse(left.value.expires_at))[0]?.value ?? null;
  }

  // Test helper: every pass ever issued for a decision, newest last.
  public listForDecision(decisionId: string): Array<{ pass: Pass; revokedAt: string | null }> {
    return [...this.passes.values()]
      .filter((row) => row.value.decision_id === decisionId)
      .map((row) => ({ pass: row.value, revokedAt: row.revokedAt }));
  }
}

function isActive(row: StoredPass, now: Date): boolean {
  return row.revokedAt === null && Date.parse(row.value.expires_at) > now.getTime();
}
