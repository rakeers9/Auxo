import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import { DecideRequestSchema } from "@auxo/shared";

import type { AuthService, AuthenticatedUser } from "./auth/auth-service.js";
import {
  InMemoryDecisionRepository,
  type DecisionRepository,
} from "./repositories/decision-repository.js";
import { DecisionService } from "./services/decision-service.js";

const DEVELOPMENT_USER_ID = "00000000-0000-4000-8000-000000000001";

export interface BuildAppOptions {
  corsOrigins?: string[];
  logger?: boolean;
  authRequired?: boolean;
  authService?: AuthService;
  decisionRepository?: DecisionRepository;
  decisionTtlSeconds?: number;
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
  const app = Fastify({ logger: options.logger ?? false });
  const corsOrigins = options.corsOrigins ?? [];
  const authRequired = options.authRequired ?? false;
  const decisionService = new DecisionService({
    repository: options.decisionRepository ?? new InMemoryDecisionRepository(),
    ttlSeconds: options.decisionTtlSeconds ?? 86_400,
  });

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

    const verdict = await decisionService.decide(user.id, parsed.data.cart);
    return reply.status(200).send(verdict);
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
