import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import {
  CheckInSchema,
  ActivePassQuerySchema,
  CreatePassRequestSchema,
  CreateBudgetSchema,
  CreateRuleSchema,
  DecideRequestSchema,
  DecisionEventSchema,
  RuleConfigurationSchemas,
  UpdateBudgetSchema,
  UpdateRuleSchema,
} from "@auxo/shared";
import { z } from "zod";

import type { AuthService, AuthenticatedUser } from "./auth/auth-service.js";
import {
  InMemoryDecisionRepository,
  type DecisionRepository,
} from "./repositories/decision-repository.js";
import {
  InMemoryOutcomeRepository,
  type OutcomeRepository,
} from "./repositories/outcome-repository.js";
import { DecisionService } from "./services/decision-service.js";
import { DecisionNotFoundError, OutcomeService } from "./services/outcome-service.js";
import {
  InMemorySettingsRepository,
  type SettingsRepository,
} from "./repositories/settings-repository.js";
import { SettingNotFoundError, SettingsService } from "./services/settings-service.js";
import type { DecisionModelProvider } from "./services/decision-model-provider.js";
import { InMemoryPassRepository, type PassRepository } from "./repositories/pass-repository.js";
import { PassNotAvailableError, PassService } from "./services/pass-service.js";
import {
  InMemoryStoreConfigRepository,
  type StoreConfigRepository,
} from "./repositories/store-config-repository.js";
import { StoreConfigService } from "./services/store-config-service.js";
import {
  InMemoryRateLimitStore,
  RateLimiter,
  rateLimitKey,
  type RateLimitStore,
} from "./rate-limit.js";

const DEVELOPMENT_USER_ID = "00000000-0000-4000-8000-000000000001";

// Cap on an event's `metadata`, measured as UTF-8 bytes of its JSON. Metadata
// carries item lists for removed/bought events, so leave room for a few dozen
// items while keeping arbitrary blobs out of the outcomes table.
export const MAX_EVENT_METADATA_BYTES = 16 * 1024;

export interface BuildAppOptions {
  corsOrigins?: string[];
  logger?: boolean;
  authRequired?: boolean;
  authService?: AuthService;
  decisionRepository?: DecisionRepository;
  outcomeRepository?: OutcomeRepository;
  settingsRepository?: SettingsRepository;
  decisionTtlSeconds?: number;
  decisionModelProvider?: DecisionModelProvider;
  passRepository?: PassRepository;
  passTtlSeconds?: number;
  storeConfigRepository?: StoreConfigRepository;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  rateLimitStore?: RateLimitStore;
  // Trust X-Forwarded-For for request.ip. Needed behind Vercel's proxy, where
  // the socket address is the proxy's, not the client's.
  trustProxy?: boolean;
}

function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;

  if (!authorization) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || null;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 64 * 1024,
    trustProxy: options.trustProxy ?? false,
  });
  const corsOrigins = options.corsOrigins ?? [];
  const authRequired = options.authRequired ?? false;
  const decisionRepository = options.decisionRepository ?? new InMemoryDecisionRepository();
  const defaultSettingsRepository = options.settingsRepository ? null : new InMemorySettingsRepository();
  const settingsRepository = options.settingsRepository ?? defaultSettingsRepository!;
  const decisionService = new DecisionService({
    repository: decisionRepository,
    settingsRepository,
    ...(options.decisionModelProvider
      ? { decisionModelProvider: options.decisionModelProvider }
      : {}),
    onDecisionModelError: (error) =>
      app.log.warn({ error }, "Decision model evaluation failed; using fallback"),
    ttlSeconds: options.decisionTtlSeconds ?? 86_400,
  });
  const outcomeService = new OutcomeService(
    decisionRepository,
    options.outcomeRepository ?? new InMemoryOutcomeRepository({
      decisions: decisionRepository,
      // `bought` charges budgets only when the settings are in memory too;
      // runtime.ts wires the Supabase repositories together itself.
      ...(defaultSettingsRepository ? { spend: defaultSettingsRepository } : {}),
    }),
  );
  const settingsService = new SettingsService(
    settingsRepository,
  );
  const passService = new PassService(
    decisionRepository,
    options.passRepository ?? new InMemoryPassRepository(),
    options.passTtlSeconds ?? 600,
  );
  const storeConfigService = new StoreConfigService(
    options.storeConfigRepository ?? new InMemoryStoreConfigRepository(),
    (entry) => app.log.warn({ entry }, "Skipped a store config entry"),
  );
  const rateLimiter = new RateLimiter(
    options.rateLimitStore ?? new InMemoryRateLimitStore(),
    options.rateLimitMax ?? 120,
    options.rateLimitWindowMs ?? 60_000,
  );

  void app.register(cors, {
    origin: corsOrigins.length === 0 ? true : corsOrigins,
  });

  // One auth lookup per request: the rate limiter and the route share it.
  const authentications = new WeakMap<FastifyRequest, Promise<AuthenticatedUser | null>>();

  function authenticate(request: FastifyRequest): Promise<AuthenticatedUser | null> {
    let authentication = authentications.get(request);
    if (!authentication) {
      authentication = authenticateToken(bearerToken(request));
      authentications.set(request, authentication);
    }
    return authentication;
  }

  async function authenticateToken(token: string | null): Promise<AuthenticatedUser | null> {
    if (!token) {
      return authRequired ? null : { id: DEVELOPMENT_USER_ID };
    }

    if (!options.authService) {
      return null;
    }

    return options.authService.authenticate(token);
  }

  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.url === "/health") return;
    // Only a bearer token identifies a user. The development user (no token)
    // stands in for every local caller, so it is limited by IP instead.
    const user = bearerToken(request) ? await authenticate(request) : null;
    let decision;
    try {
      decision = await rateLimiter.consume(rateLimitKey(user?.id ?? null, request.ip));
    } catch (error) {
      // Fail open: a broken limiter store must not take the API down.
      request.log.warn({ error }, "Rate limit store failed; allowing the request");
      return;
    }
    if (decision.limited) {
      reply.header("retry-after", decision.retryAfterSeconds);
      return reply.status(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests. Try again shortly." } });
    }
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/v1/decide", async (request, reply) => {
    const user = await authenticate(request);

    if (!user) {
      return reply.status(401).send({
        error: {
          code: "UNAUTHORIZED",
          message: "A valid bearer token is required.",
        },
      });
    }

    const parsed = DecideRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "The decide request is invalid.",
          details: parsed.error.flatten(),
        },
      });
    }

    const verdict = await decisionService.decide(user.id, parsed.data.cart, parsed.data.trigger);
    return reply.status(200).send(verdict);
  });

  app.post("/v1/events", async (request, reply) => {
    const user = await authenticate(request);

    if (!user) {
      return reply.status(401).send({
        error: {
          code: "UNAUTHORIZED",
          message: "A valid bearer token is required.",
        },
      });
    }

    const parsed = DecisionEventSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "The event request is invalid.",
          details: parsed.error.flatten(),
        },
      });
    }

    if (
      parsed.data.metadata !== undefined &&
      Buffer.byteLength(JSON.stringify(parsed.data.metadata), "utf8") > MAX_EVENT_METADATA_BYTES
    ) {
      return invalidRequest(reply, "The event request is invalid.", {
        formErrors: [],
        fieldErrors: {
          metadata: [`metadata must be at most ${MAX_EVENT_METADATA_BYTES} bytes as JSON.`],
        },
      });
    }

    const receipt = await outcomeService.recordEvent(user.id, parsed.data);
    return reply.status(receipt.duplicate ? 200 : 201).send(receipt);
  });

  app.post("/v1/check-ins", async (request, reply) => {
    const user = await authenticate(request);

    if (!user) {
      return reply.status(401).send({
        error: {
          code: "UNAUTHORIZED",
          message: "A valid bearer token is required.",
        },
      });
    }

    const parsed = CheckInSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "The check-in request is invalid.",
          details: parsed.error.flatten(),
        },
      });
    }

    const receipt = await outcomeService.recordCheckIn(user.id, parsed.data);
    return reply.status(receipt.duplicate ? 200 : 201).send(receipt);
  });

  app.post("/v1/passes", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return unauthorized(reply);
    const parsed = CreatePassRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, "The pass request is invalid.", parsed.error.flatten());
    return reply.status(201).send(await passService.issue(user.id, parsed.data.decision_id));
  });

  app.get("/v1/passes/active", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return unauthorized(reply);
    const parsed = ActivePassQuerySchema.safeParse(request.query);
    if (!parsed.success) return invalidRequest(reply, "The active pass query is invalid.", parsed.error.flatten());
    return reply.send({ pass: await passService.active(user.id, parsed.data.cart_hash) });
  });

  // Store selector overrides and on/off switches (StoreConfig). The same for
  // every user, but authenticated like every other route.
  app.get("/v1/config", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return unauthorized(reply);
    return reply.send(await storeConfigService.getConfig());
  });

  const IdParamsSchema = z.object({ id: z.string().uuid() }).strict();

  app.get("/v1/rules", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return unauthorized(reply);
    return reply.send({ rules: await settingsService.listRules(user.id) });
  });

  app.post("/v1/rules", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return unauthorized(reply);
    const parsed = CreateRuleSchema.safeParse(request.body);
    if (!parsed.success) {
      return invalidRequest(reply, "The rule request is invalid.", parsed.error.flatten());
    }
    return reply.status(201).send(await settingsService.createRule(user.id, parsed.data));
  });

  app.patch("/v1/rules/:id", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return unauthorized(reply);
    const params = IdParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, "The rule ID is invalid.", params.error.flatten());
    const body = UpdateRuleSchema.safeParse(request.body);
    if (!body.success) {
      return invalidRequest(reply, "The rule update is invalid.", body.error.flatten());
    }
    let update = body.data;
    if (update.configuration !== undefined) {
      // A rule's type can't change, so the new configuration must fit the stored type.
      const rule = (await settingsService.listRules(user.id)).find((row) => row.id === params.data.id);
      if (!rule) throw new SettingNotFoundError();
      const checked = z
        .object({ configuration: RuleConfigurationSchemas[rule.rule_type] })
        .safeParse({ configuration: update.configuration });
      if (!checked.success) {
        return invalidRequest(reply, "The rule update is invalid.", checked.error.flatten());
      }
      update = { ...update, configuration: checked.data.configuration };
    }
    return reply.send(await settingsService.updateRule(user.id, params.data.id, update));
  });

  app.delete("/v1/rules/:id", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return unauthorized(reply);
    const params = IdParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, "The rule ID is invalid.");
    await settingsService.deleteRule(user.id, params.data.id);
    return reply.status(204).send();
  });

  app.get("/v1/budgets", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return unauthorized(reply);
    return reply.send({ budgets: await settingsService.listBudgets(user.id) });
  });

  app.post("/v1/budgets", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return unauthorized(reply);
    const parsed = CreateBudgetSchema.safeParse(request.body);
    if (!parsed.success) {
      return invalidRequest(reply, "The budget request is invalid.", parsed.error.flatten());
    }
    return reply.status(201).send(await settingsService.createBudget(user.id, parsed.data));
  });

  app.patch("/v1/budgets/:id", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return unauthorized(reply);
    const params = IdParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, "The budget ID is invalid.", params.error.flatten());
    const body = UpdateBudgetSchema.safeParse(request.body);
    if (!body.success) {
      return invalidRequest(reply, "The budget update is invalid.", body.error.flatten());
    }
    return reply.send(await settingsService.updateBudget(user.id, params.data.id, body.data));
  });

  app.delete("/v1/budgets/:id", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return unauthorized(reply);
    const params = IdParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, "The budget ID is invalid.");
    await settingsService.deleteBudget(user.id, params.data.id);
    return reply.status(204).send();
  });

  app.setNotFoundHandler(async (_request, reply) =>
    reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: "Route not found.",
      },
    }),
  );

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof DecisionNotFoundError) {
      return reply.status(404).send({
        error: {
          code: "DECISION_NOT_FOUND",
          message: "The decision does not exist for the authenticated user.",
        },
      });
    }

    if (error instanceof SettingNotFoundError) {
      return reply.status(404).send({
        error: {
          code: "SETTING_NOT_FOUND",
          message: "The setting does not exist for the authenticated user.",
        },
      });
    }

    if (error instanceof PassNotAvailableError) {
      return reply.status(409).send({
        error: { code: "PASS_NOT_AVAILABLE", message: error.message, details: { reason: error.reason } },
      });
    }

    app.log.error(error);
    return reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
      },
    });
  });

  return app;
}

function unauthorized(reply: { status(code: number): { send(payload: unknown): unknown } }) {
  return reply.status(401).send({
    error: { code: "UNAUTHORIZED", message: "A valid bearer token is required." },
  });
}

function invalidRequest(
  reply: { status(code: number): { send(payload: unknown): unknown } },
  message: string,
  details?: unknown,
) {
  return reply.status(400).send({
    error: { code: "INVALID_REQUEST", message, ...(details ? { details } : {}) },
  });
}
