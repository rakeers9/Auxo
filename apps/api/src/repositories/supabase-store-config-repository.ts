import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { MerchantRow, RecipeRow, StoreConfigRepository } from "./store-config-repository.js";

const MerchantRowSchema = z.object({
  id: z.string().min(1),
  domain: z.string(),
  enabled: z.boolean(),
});

// `selectors` stays raw jsonb here; the service validates it.
const RecipeRowSchema = z.object({
  merchant_id: z.string().min(1),
  version: z.number().int(),
  selectors: z.unknown(),
});

export type InvalidStoreConfigRow = (entry: {
  table: "merchants" | "recipes";
  row: unknown;
  issues: z.core.$ZodIssue[];
}) => void;

export class SupabaseStoreConfigRepository implements StoreConfigRepository {
  public constructor(
    private readonly client: Pick<SupabaseClient, "from">,
    private readonly onInvalidRow: InvalidStoreConfigRow = (entry) =>
      console.warn("Skipped an invalid store config row", JSON.stringify(entry)),
  ) {}

  public async listMerchants(): Promise<MerchantRow[]> {
    const { data, error } = await this.client.from("merchants").select("id,domain,enabled").order("domain");
    if (error) throw new Error("Unable to list merchants.", { cause: error });
    return this.parseRows("merchants", data, MerchantRowSchema);
  }

  public async listEnabledRecipes(): Promise<RecipeRow[]> {
    const { data, error } = await this.client
      .from("recipes")
      .select("merchant_id,version,selectors")
      .eq("enabled", true)
      .order("version", { ascending: false });
    if (error) throw new Error("Unable to list recipes.", { cause: error });
    return this.parseRows("recipes", data, RecipeRowSchema);
  }

  // Keep the rows that match the schema; skip and report the rest.
  private parseRows<T>(
    table: "merchants" | "recipes",
    data: unknown,
    schema: z.ZodType<T>,
  ): T[] {
    const rows: T[] = [];
    for (const row of Array.isArray(data) ? data : []) {
      const parsed = schema.safeParse(row);
      if (parsed.success) rows.push(parsed.data);
      else this.onInvalidRow({ table, row, issues: parsed.error.issues });
    }
    return rows;
  }
}
