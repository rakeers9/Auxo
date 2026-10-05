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

const DEVELOPMENT_USER_ID = "00000000-0000-4000-8000-000000000001";

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
}

function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;

  if (!authorization) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || null;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 64 * 1024 });
  const corsOrigins = options.corsOrigins ?? [];
  const authRequired = options.authRequired ?? false;
  const decisionRepository = options.decisionRepository ?? new InMemoryDecisionRepository();
  const settingsRepository = options.settingsRepository ?? new InMemorySettingsRepository();
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
    options.outcomeRepository ?? new InMemoryOutcomeRepository(),
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
  const rateLimitMax = options.rateLimitMax ?? 120;
  const rateLimitWindowMs = options.rateLimitWindowMs ?? 60_000;
  const requestWindows = new Map<string, { startedAt: number; count: number }>();

  await app.register(cors, {
    origin: corsOrigins.length === 0 ? true : corsOrigins,
  });

  async function authenticate(request: FastifyRequest): Promise<AuthenticatedUser | null> {
    const token = bearerToken(request);

    if (!token) {
      return authRequired ? null : { id: DEVELOPMENT_USER_ID };
    }

    if (!options.authService) {
      return null;
    }

    return options.authService.authenticate(token);
  }

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

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
    const now = Date.now();
    if (requestWindows.size > 10_000) {
      for (const [key, value] of requestWindows) {
        if (now - value.startedAt >= rateLimitWindowMs) requestWindows.delete(key);
      }
    }
    const current = requestWindows.get(request.ip);
    const window = !current || now - current.startedAt >= rateLimitWindowMs
      ? { startedAt: now, count: 1 }
      : { ...current, count: current.count + 1 };
    requestWindows.set(request.ip, window);
    if (window.count > rateLimitMax) {
      reply.header("retry-after", Math.max(1, Math.ceil((window.startedAt + rateLimitWindowMs - now) / 1_000)));
      return reply.status(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests. Try again shortly." } });
    }
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
    const body = UpdateRuleSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return invalidRequest(reply, "The rule update is invalid.");
    }
    return reply.send(await settingsService.updateRule(user.id, params.data.id, body.data));
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
    const body = UpdateBudgetSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return invalidRequest(reply, "The budget update is invalid.");
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
        error: { code: "PASS_NOT_AVAILABLE", message: error.message },
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
