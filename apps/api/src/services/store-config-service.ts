import { createHash } from "node:crypto";

import {
  StoreConfigSchema,
  StoreOverridesSchema,
  type StoreConfig,
  type StoreOverrides,
} from "@auxo/shared";

import type { RecipeRow, StoreConfigRepository } from "../repositories/store-config-repository.js";

// A recipe's jsonb is the overrides minus `enabled` (that comes from the merchant).
const RecipeOverridesSchema = StoreOverridesSchema.omit({ enabled: true });
const HostSchema = StoreConfigSchema.shape.stores.keyType;

export interface SkippedStoreEntry {
  domain: string;
  recipe_version?: number;
  reason: string;
}

// Builds the store config the extension fetches. Per store: the merchant's
// on/off switch plus its latest enabled recipe. A bad row is skipped (and
// reported) so it can't break the other stores; a merchant whose latest
// recipe is bad is sent with no overrides rather than an older version, so
// the extension falls back to its bundled selectors.
export class StoreConfigService {
  public constructor(
    private readonly repository: StoreConfigRepository,
    private readonly onSkipped: (entry: SkippedStoreEntry) => void = () => {},
  ) {}

  public async getConfig(): Promise<StoreConfig> {
    const [merchants, recipes] = await Promise.all([
      this.repository.listMerchants(),
      this.repository.listEnabledRecipes(),
    ]);
    const latest = latestByMerchant(recipes);
    const stores: Record<string, StoreOverrides> = {};

    // Deterministic, and if two domains differ only by case, the one already
    // written in lowercase wins.
    const rank = (domain: string) => (domain === domain.toLowerCase() ? 0 : 1);
    const ordered = [...merchants].sort(
      (a, b) =>
        compare(a.domain.toLowerCase(), b.domain.toLowerCase()) ||
        rank(a.domain) - rank(b.domain) ||
        compare(a.id, b.id),
    );
    for (const merchant of ordered) {
      // Hostnames are lowercase in the extension's URLs.
      const host = HostSchema.safeParse(merchant.domain.toLowerCase());
      if (!host.success) {
        this.onSkipped({ domain: merchant.domain, reason: "domain isn't a valid hostname key" });
        continue;
      }
      if (Object.hasOwn(stores, host.data)) {
        this.onSkipped({ domain: merchant.domain, reason: `another merchant already uses ${host.data}` });
        continue;
      }
      if (!merchant.enabled) {
        stores[host.data] = { enabled: false };
        continue;
      }

      const recipe = latest.get(merchant.id);
      if (!recipe) {
        stores[host.data] = { enabled: true };
        continue;
      }
      const overrides = RecipeOverridesSchema.safeParse(recipe.selectors);
      if (!overrides.success) {
        this.onSkipped({
          domain: merchant.domain,
          recipe_version: recipe.version,
          reason: overrides.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "),
        });
        stores[host.data] = { enabled: true };
        continue;
      }
      stores[host.data] = { enabled: true, ...overrides.data };
    }

    return StoreConfigSchema.parse({ version: versionOf(stores), stores });
  }
}

function latestByMerchant(recipes: RecipeRow[]): Map<string, RecipeRow> {
  const latest = new Map<string, RecipeRow>();
  for (const recipe of recipes) {
    const current = latest.get(recipe.merchant_id);
    if (!current || recipe.version > current.version) latest.set(recipe.merchant_id, recipe);
  }
  return latest;
}

// A hash of exactly what is served, so it changes whenever the extension
// would see something different (including deletes) and never otherwise.
export function versionOf(stores: Record<string, StoreOverrides>): string {
  if (Object.keys(stores).length === 0) return "default";
  return createHash("sha256").update(stableStringify(stores)).digest("hex");
}

// JSON with object keys sorted at every level; array order is kept.
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => compare(a, b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
