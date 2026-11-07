import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReadFailureReport } from "@auxo/shared";
import { describe, expect, it } from "vitest";

import { SupabaseReadFailureRepository } from "./supabase-read-failure-repository.js";

const report: ReadFailureReport = {
  reader: "amazon_cart",
  page_type: "cart",
  store_host: "www.amazon.com",
  extension_version: "0.0.0",
  codes: ["item.no_price", "total.mismatch"],
  day: "2026-10-26",
};

function fakeClient(error: unknown = null) {
  const inserts: Array<{ table: string; row: unknown }> = [];
  const client = {
    from: (table: string) => ({
      insert: async (row: unknown) => {
        inserts.push({ table, row });
        return { data: null, error };
      },
    }),
  };
  return { client: client as unknown as SupabaseClient, inserts };
}

describe("SupabaseReadFailureRepository", () => {
  it("inserts exactly the report's fields into read_failures", async () => {
    const { client, inserts } = fakeClient();
    await new SupabaseReadFailureRepository(client).record(report);
    expect(inserts).toEqual([{ table: "read_failures", row: { ...report } }]);
  });

  it("throws when the insert fails", async () => {
    const { client } = fakeClient({ code: "42501", message: "denied" });
    await expect(new SupabaseReadFailureRepository(client).record(report)).rejects.toThrow("Unable to record the read failure.");
  });
});
