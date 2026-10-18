import { describe, expect, it, vi } from "vitest";

import {
  SupabaseStoreConfigRepository,
  type InvalidStoreConfigRow,
} from "./supabase-store-config-repository.js";

// A stand-in for the query builder: every chained call returns itself, and
// awaiting it resolves to the given result.
function fakeClient(results: Record<string, { data: unknown; error: unknown }>) {
  const tables: string[] = [];
  const client = {
    from(table: string) {
      tables.push(table);
      const result = results[table] ?? { data: [], error: null };
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject),
      };
      return query;
    },
  };
  return { client: client as unknown as ConstructorParameters<typeof SupabaseStoreConfigRepository>[0], tables };
}

describe("SupabaseStoreConfigRepository", () => {
  it("returns valid merchant rows and skips invalid ones", async () => {
    const valid = { id: "m1", domain: "www.amazon.com", enabled: true };
    const { client } = fakeClient({
      merchants: {
        data: [valid, { id: "m2", domain: "www.example.com", enabled: "yes" }, null],
        error: null,
      },
    });
    const onInvalidRow = vi.fn<InvalidStoreConfigRow>();
    const repository = new SupabaseStoreConfigRepository(client, onInvalidRow);

    await expect(repository.listMerchants()).resolves.toEqual([valid]);
    expect(onInvalidRow).toHaveBeenCalledTimes(2);
    expect(onInvalidRow.mock.calls[0]?.[0]).toMatchObject({
      table: "merchants",
      row: { id: "m2" },
      issues: [expect.objectContaining({ path: ["enabled"] })],
    });
  });

  it("returns valid recipe rows with their raw selectors and skips invalid ones", async () => {
    const valid = { merchant_id: "m1", version: 2, selectors: { buttons: {} } };
    const { client, tables } = fakeClient({
      recipes: { data: [valid, { merchant_id: "m1", version: "3", selectors: {} }], error: null },
    });
    const onInvalidRow = vi.fn<InvalidStoreConfigRow>();
    const repository = new SupabaseStoreConfigRepository(client, onInvalidRow);

    await expect(repository.listEnabledRecipes()).resolves.toEqual([valid]);
    expect(tables).toEqual(["recipes"]);
    expect(onInvalidRow).toHaveBeenCalledOnce();
    expect(onInvalidRow.mock.calls[0]?.[0]).toMatchObject({ table: "recipes", issues: [expect.objectContaining({ path: ["version"] })] });
  });

  it("treats a missing result as no rows", async () => {
    const { client } = fakeClient({ merchants: { data: null, error: null } });
    const repository = new SupabaseStoreConfigRepository(client, vi.fn());

    await expect(repository.listMerchants()).resolves.toEqual([]);
  });

  it("throws when the query fails", async () => {
    const { client } = fakeClient({ recipes: { data: null, error: { message: "boom" } } });
    const repository = new SupabaseStoreConfigRepository(client, vi.fn());

    await expect(repository.listEnabledRecipes()).rejects.toThrow("Unable to list recipes.");
  });
});
