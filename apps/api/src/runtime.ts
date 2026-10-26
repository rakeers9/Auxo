import { createClient } from "@supabase/supabase-js";

import { buildApp } from "./application.js";
import { SupabaseAuthService } from "./auth/auth-service.js";
import { loadConfig } from "./config.js";
import { InMemoryDecisionRepository } from "./repositories/decision-repository.js";
import { InMemoryOutcomeRepository } from "./repositories/outcome-repository.js";
import { InMemoryPassRepository } from "./repositories/pass-repository.js";
import { InMemorySettingsRepository } from "./repositories/settings-repository.js";
import { SupabaseDecisionRepository } from "./repositories/supabase-decision-repository.js";
import { SupabaseOutcomeRepository } from "./repositories/supabase-outcome-repository.js";
import { InMemoryHistoryRepository } from "./repositories/history-repository.js";
import { SupabaseHistoryRepository } from "./repositories/supabase-history-repository.js";
import { SupabasePassRepository } from "./repositories/supabase-pass-repository.js";
import { SupabaseSettingsRepository } from "./repositories/supabase-settings-repository.js";
import { CloudflareClefProvider } from "./services/decision-model-provider.js";
import { InMemoryStoreConfigRepository } from "./repositories/store-config-repository.js";
import { SupabaseStoreConfigRepository } from "./repositories/supabase-store-config-repository.js";
import { InMemoryReadFailureRepository } from "./repositories/read-failure-repository.js";
import { SupabaseReadFailureRepository } from "./repositories/supabase-read-failure-repository.js";

export function createProductionApp() {
  const config = loadConfig();
  const authClient = config.supabaseUrl && config.supabaseAnonKey
    ? createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;
  const serviceClient = config.supabaseUrl && config.supabaseServiceRoleKey
    ? createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;

  // In memory, the outcome repository shares the decision and settings
  // repositories so `bought` events update budget spend like the database does,
  // and the history repository reads the decisions and outcomes.
  const memoryDecisions = new InMemoryDecisionRepository();
  const memorySettings = new InMemorySettingsRepository();
  const memoryOutcomes = new InMemoryOutcomeRepository({ decisions: memoryDecisions, spend: memorySettings });

  return buildApp({
    corsOrigins: config.corsOrigins,
    logger: true,
    authRequired: config.authMode === "required",
    ...(authClient ? { authService: new SupabaseAuthService(authClient) } : {}),
    decisionRepository: serviceClient
      ? new SupabaseDecisionRepository(serviceClient)
      : memoryDecisions,
    outcomeRepository: serviceClient
      ? new SupabaseOutcomeRepository(serviceClient)
      : memoryOutcomes,
    // Merchant history for /v1/decide (AUX-34), read from the same store.
    historyRepository: serviceClient
      ? new SupabaseHistoryRepository(serviceClient)
      : new InMemoryHistoryRepository({ decisions: memoryDecisions, outcomes: memoryOutcomes }),
    settingsRepository: serviceClient
      ? new SupabaseSettingsRepository(serviceClient)
      : memorySettings,
    passRepository: serviceClient
      ? new SupabasePassRepository(serviceClient)
      : new InMemoryPassRepository(),
    storeConfigRepository: serviceClient
      ? new SupabaseStoreConfigRepository(serviceClient)
      : new InMemoryStoreConfigRepository(),
    // Reader failure codes (AUX-47).
    readFailureRepository: serviceClient
      ? new SupabaseReadFailureRepository(serviceClient)
      : new InMemoryReadFailureRepository(),
    decisionTtlSeconds: config.decisionTtlSeconds,
    passTtlSeconds: config.passTtlSeconds,
    rateLimitMax: config.rateLimitMax,
    rateLimitWindowMs: config.rateLimitWindowMs,
    trustProxy: config.trustProxy,
    ...(config.cloudflareAccountId && config.cloudflareApiToken
      ? {
          decisionModelProvider: new CloudflareClefProvider({
            accountId: config.cloudflareAccountId,
            apiToken: config.cloudflareApiToken,
            model: config.clefModel,
            timeoutMs: config.decisionModelTimeoutMs,
          }),
        }
      : {}),
  });
}

const app = createProductionApp();

export default app;
