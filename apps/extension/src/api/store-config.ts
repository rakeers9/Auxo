import { StoreConfigSchema, type StoreConfig, type StoreOverrides } from "@auxo/shared";

import type { KeyValueArea } from "./decision-memory";

// How long a fetched config is used before asking the backend again. A fix
// pushed to the backend reaches users within this window.
export const CONFIG_MAX_AGE_MS = 5 * 60_000;
export const CONFIG_TIMEOUT_MS = 2_500;
const KEY = "auxo:store-config";

// GET /v1/config. Returns null on any failure or invalid response.
export async function fetchStoreConfig(options: {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<StoreConfig | null> {
  const fetchFn = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? CONFIG_TIMEOUT_MS);
  try {
    const response = await fetchFn(new URL("/v1/config", options.baseUrl), { signal: controller.signal });
    if (!response.ok) return null;
    const parsed = StoreConfigSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface ConfigCache {
  // The freshest good config: cached if recent, otherwise fetched; if the
  // fetch fails, the last good copy; null if there has never been one (then
  // the extension uses its bundled defaults).
  get(): Promise<StoreConfig | null>;
}

export function createConfigCache(deps: {
  load: () => Promise<StoreConfig | null>;
  area: KeyValueArea;
  now?: () => number;
  maxAgeMs?: number;
}): ConfigCache {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? CONFIG_MAX_AGE_MS;
  let inflight: Promise<StoreConfig | null> | null = null;

  const readCached = async (): Promise<{ config: StoreConfig; fetchedAt: number } | null> => {
    try {
      const value = (await deps.area.get(KEY))[KEY] as { config?: unknown; fetchedAt?: unknown } | undefined;
      const parsed = StoreConfigSchema.safeParse(value?.config);
      return parsed.success && typeof value?.fetchedAt === "number" ? { config: parsed.data, fetchedAt: value.fetchedAt } : null;
    } catch {
      return null;
    }
  };

  const refresh = async (cached: { config: StoreConfig } | null): Promise<StoreConfig | null> => {
    const fresh = await deps.load().catch(() => null);
    if (!fresh) return cached?.config ?? null;
    try {
      await deps.area.set({ [KEY]: { config: fresh, fetchedAt: now() } });
    } catch {
      // Still use it for this answer.
    }
    return fresh;
  };

  return {
    async get() {
      const cached = await readCached();
      if (cached && now() - cached.fetchedAt < maxAgeMs) return cached.config;
      // One fetch at a time, shared by everyone asking meanwhile.
      inflight ??= refresh(cached).finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}

// The overrides for one host, or null when the backend has none for it.
export function overridesFor(config: StoreConfig | null, host: string): StoreOverrides | null {
  return config?.stores[host] ?? null;
}
