// Store selector overrides live in the `merchants` and `recipes` tables.
// A merchant row is one store (its `domain` is the hostname, e.g.
// "www.amazon.com") with an on/off switch. Each recipe is a numbered version
// of that store's overrides; `recipes.selectors` holds `{ buttons?, selectors? }`.

export interface MerchantRow {
  id: string;
  domain: string;
  enabled: boolean;
}

export interface RecipeRow {
  merchant_id: string;
  version: number;
  // Raw jsonb: validated by the service, never trusted here.
  selectors: unknown;
}

export interface StoreConfigRepository {
  listMerchants(): Promise<MerchantRow[]>;
  // Only recipes with enabled = true.
  listEnabledRecipes(): Promise<RecipeRow[]>;
}

export interface SeedRecipe extends RecipeRow {
  enabled: boolean;
}

export class InMemoryStoreConfigRepository implements StoreConfigRepository {
  private readonly merchants = new Map<string, MerchantRow>();
  private readonly recipes = new Map<string, SeedRecipe>();

  public constructor(seed: { merchants?: MerchantRow[]; recipes?: SeedRecipe[] } = {}) {
    for (const merchant of seed.merchants ?? []) this.upsertMerchant(merchant);
    for (const recipe of seed.recipes ?? []) this.upsertRecipe(recipe);
  }

  public async listMerchants(): Promise<MerchantRow[]> {
    return [...this.merchants.values()].map((row) => ({ ...row }));
  }

  public async listEnabledRecipes(): Promise<RecipeRow[]> {
    return [...this.recipes.values()]
      .filter((row) => row.enabled)
      .map(({ merchant_id, version, selectors }) => ({ merchant_id, version, selectors }));
  }

  public upsertMerchant(merchant: MerchantRow): void {
    this.merchants.set(merchant.id, { ...merchant });
  }

  // Keyed like the table's unique (merchant_id, version).
  public upsertRecipe(recipe: SeedRecipe): void {
    this.recipes.set(recipeKey(recipe.merchant_id, recipe.version), { ...recipe });
  }

  public deleteRecipe(merchantId: string, version: number): boolean {
    return this.recipes.delete(recipeKey(merchantId, version));
  }
}

function recipeKey(merchantId: string, version: number): string {
  return `${merchantId}:${version}`;
}
