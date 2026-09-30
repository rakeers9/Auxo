import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";

import { DecideRequestSchema } from "@auxo/shared";

import { createStubVerdict } from "./services/stub-decision.js";

export interface BuildAppOptions {
  corsOrigins?: string[];
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const corsOrigins = options.corsOrigins ?? [];

  await app.register(cors, {
    origin: corsOrigins.length === 0 ? true : corsOrigins,
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/v1/decide", async (request, reply) => {
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

    return reply.status(200).send(createStubVerdict(parsed.data.cart));
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
