import type { Database } from "@forkflow/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { registerAuth } from "./auth.js";
import { registerWs } from "./ws.js";
import { registerCatalog } from "./catalog.js";
import { registerUsers } from "./users.js";
import { registerSettings } from "./settings.js";
import { registerTables } from "./tables.js";
import { registerOrders } from "./orders.js";
import { registerKots } from "./kots.js";

export interface ServerOptions {
  db: Database;
  logger?: boolean;
}

export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  // Harden content-type parser for browsers/proxies that send application/json on empty bodies
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    if (typeof body === "string" && body.trim() === "") {
      done(null, undefined);
    } else {
      try {
        const parsed = JSON.parse(body as string);
        done(null, parsed);
      } catch (err: unknown) {
        done(err instanceof Error ? err : new Error("JSON parse failed"), undefined);
      }
    }
  });

  app.decorate("db", opts.db);

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: "validation", issues: err.issues });
    }
    const status = typeof err === "object" && err !== null && "statusCode" in err && typeof err.statusCode === "number" ? err.statusCode : 500;
    const message = typeof err === "object" && err !== null && "message" in err && typeof err.message === "string" ? err.message : "Internal server error";

    if (status >= 500) {
      app.log.error(err);
      return reply.status(status).send({ error: "internal error" });
    }
    return reply.status(status).send({ error: message });
  });

  registerAuth(app);
  registerWs(app);
  registerCatalog(app);
  registerUsers(app);
  registerSettings(app);
  registerTables(app);
  registerOrders(app);
  registerKots(app);

  app.get("/api/health", async () => ({ ok: true }));

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
  }
}
