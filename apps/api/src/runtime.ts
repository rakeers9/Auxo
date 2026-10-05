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
import { SupabasePassRepository } from "./repositories/supabase-pass-repository.js";
import { SupabaseSettingsRepository } from "./repositories/supabase-settings-repository.js";
import { CloudflareClefProvider } from "./services/decision-model-provider.js";

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

  return buildApp({
    corsOrigins: config.corsOrigins,
    logger: true,
    authRequired: config.authMode === "required",
    ...(authClient ? { authService: new SupabaseAuthService(authClient) } : {}),
    decisionRepository: serviceClient
      ? new SupabaseDecisionRepository(serviceClient)
      : new InMemoryDecisionRepository(),
    outcomeRepository: serviceClient
      ? new SupabaseOutcomeRepository(serviceClient)
      : new InMemoryOutcomeRepository(),
    settingsRepository: serviceClient
      ? new SupabaseSettingsRepository(serviceClient)
      : new InMemorySettingsRepository(),
    passRepository: serviceClient
      ? new SupabasePassRepository(serviceClient)
      : new InMemoryPassRepository(),
    decisionTtlSeconds: config.decisionTtlSeconds,
    passTtlSeconds: config.passTtlSeconds,
    rateLimitMax: config.rateLimitMax,
    rateLimitWindowMs: config.rateLimitWindowMs,
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
