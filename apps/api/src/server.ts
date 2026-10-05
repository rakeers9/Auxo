import { createClient } from "@supabase/supabase-js";

import { buildApp } from "./app.js";
import { SupabaseAuthService } from "./auth/auth-service.js";
import { loadConfig } from "./config.js";
import { InMemoryDecisionRepository } from "./repositories/decision-repository.js";
import { InMemoryOutcomeRepository } from "./repositories/outcome-repository.js";
import { SupabaseDecisionRepository } from "./repositories/supabase-decision-repository.js";
import { SupabaseOutcomeRepository } from "./repositories/supabase-outcome-repository.js";
import { InMemorySettingsRepository } from "./repositories/settings-repository.js";
import { SupabaseSettingsRepository } from "./repositories/supabase-settings-repository.js";
import { CloudflareClefProvider } from "./services/decision-model-provider.js";
import { InMemoryPassRepository } from "./repositories/pass-repository.js";
import { SupabasePassRepository } from "./repositories/supabase-pass-repository.js";
import { InMemoryStoreConfigRepository } from "./repositories/store-config-repository.js";
import { SupabaseStoreConfigRepository } from "./repositories/supabase-store-config-repository.js";

const config = loadConfig();

const authClient =
  config.supabaseUrl && config.supabaseAnonKey
    ? createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;

const serviceClient =
  config.supabaseUrl && config.supabaseServiceRoleKey
    ? createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;

const app = await buildApp({
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
  decisionTtlSeconds: config.decisionTtlSeconds,
  passTtlSeconds: config.passTtlSeconds,
  rateLimitMax: config.rateLimitMax,
  rateLimitWindowMs: config.rateLimitWindowMs,
  passRepository: serviceClient
    ? new SupabasePassRepository(serviceClient)
    : new InMemoryPassRepository(),
  storeConfigRepository: serviceClient
    ? new SupabaseStoreConfigRepository(serviceClient)
    : new InMemoryStoreConfigRepository(),
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

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
