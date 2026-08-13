import type { Database } from "@forkflow/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

export interface ServerOptions {
  db: Database;
}

export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  app.decorate("db", opts.db);

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: "validation", issues: err.issues });
    }
    app.log.error(err);
    const status = typeof err === "object" && err !== null && "statusCode" in err && typeof err.statusCode === "number" ? err.statusCode : 500;
    const message = typeof err === "object" && err !== null && "message" in err && typeof err.message === "string" ? err.message : "Internal server error";
    return reply.status(status).send({ error: message });
  });

  app.get("/api/health", async () => ({ ok: true }));

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
  }
}
