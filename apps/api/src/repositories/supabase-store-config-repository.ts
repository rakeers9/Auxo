import type { SupabaseClient } from "@supabase/supabase-js";

import type { MerchantRow, RecipeRow, StoreConfigRepository } from "./store-config-repository.js";

export class SupabaseStoreConfigRepository implements StoreConfigRepository {
  public constructor(private readonly client: SupabaseClient) {}

  public async listMerchants(): Promise<MerchantRow[]> {
    const { data, error } = await this.client.from("merchants").select("id,domain,enabled").order("domain");
    if (error) throw new Error("Unable to list merchants.", { cause: error });
    return data as MerchantRow[];
  }

  public async listEnabledRecipes(): Promise<RecipeRow[]> {
    const { data, error } = await this.client
      .from("recipes")
      .select("merchant_id,version,selectors")
      .eq("enabled", true)
      .order("version", { ascending: false });
    if (error) throw new Error("Unable to list recipes.", { cause: error });
    return data as RecipeRow[];
  }
}
