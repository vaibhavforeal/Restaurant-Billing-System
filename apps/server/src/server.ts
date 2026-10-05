import type { Database } from "@forkflow/domain";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { ZodError } from "zod";
import { registerAuth } from "./auth.js";
import { registerWs } from "./ws.js";
import { registerCatalog } from "./catalog.js";
import { registerUsers } from "./users.js";
import { registerSettings } from "./settings.js";
import { registerTables } from "./tables.js";
import { registerReservations } from "./reservations.js";
import { registerOrders } from "./orders.js";
import { registerKots } from "./kots.js";
import { registerPrinters } from "./printers.js";
import { registerBilling } from "./billing.js";
import { registerReports } from "./reports.js";
import { registerSalesReports } from "./sales-reports.js";
import { registerOperationalReports } from "./operational-reports.js";
import { registerOrderAnalytics } from "./order-analytics.js";
import { registerStock } from "./stock.js";
import { registerCosting } from "./costing.js";
import { registerGuestOrdering } from "./guest-ordering.js";
import { registerGuestServices } from "./guest-services.js";
import { registerSystem } from "./system.js";
import type { Backups } from "./backups.js";
import { CloudBackups, type CloudBackupProvider } from "./cloud-backups.js";
import { realSend, type SinkSend } from "./print/sinks.js";
import { PrintQueue } from "./print/queue.js";
import { readProfile } from "./print/profile.js";
import { discoverWindowsPrinters, type PrinterDiscovery } from "./print/discovery.js";
import { configureLicensing, registerLicensing, type LicensingOptions } from "./licensing.js";
import type { CaptainHttpsInfo } from "./captain-https.js";
import { registerZomato, type ZomatoProvider } from "./zomato.js";

export interface ServerOptions {
  demo?: boolean;
  db: Database;
  logger?: FastifyServerOptions["logger"];
  authTimeoutMs?: number;  // WS auth frame timeout (default 5000ms in registerWs)
  sinkSend?: SinkSend;
  discoverPrinters?: () => Promise<PrinterDiscovery>;
  backups?: Backups;
  cloudBackupProvider?: CloudBackupProvider;
  port?: number;
  generation?: string;
  instanceId?: string;
  licensing?: LicensingOptions;
  captainHttps?: CaptainHttpsInfo;
  zomatoProvider?: ZomatoProvider;
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

  const queue = new PrintQueue(opts.sinkSend ?? realSend, (job) => {
    app.broadcast("print.job", { job });
  }, opts.db, opts.generation);
  app.decorate("printQueue", queue);
  app.addHook("onReady", async () => queue.start());
  app.addHook("preClose", async () => queue.close());

  app.decorate("enqueuePrint", (stationId: string, kind: "kot" | "cancel", label: string, bytes: Buffer) => {
    interface StationRow {
      printer_id: string | null;
    }
    const station = app.db
      .prepare("SELECT printer_id FROM kot_stations WHERE id = ? AND is_active = 1")
      .get(stationId) as StationRow | undefined;

    if (!station || !station.printer_id) return;

    interface PrinterRow {
      id: string;
      name: string;
      kind: "network" | "windows" | "bluetooth";
      connection: string;
      is_active: number;
      kot_profile: string;
    }
    const printer = app.db
      .prepare("SELECT id, name, kind, connection, is_active, kot_profile FROM printers WHERE id = ?")
      .get(station.printer_id) as PrinterRow | undefined;

    if (!printer || printer.is_active !== 1) return;

    queue.enqueue(printer, kind, label, bytes, readProfile(printer.kot_profile).copies);
  });

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
    const code = typeof err === "object" && err !== null && "code" in err && err.code === "menu_changed" ? err.code : undefined;
    return reply.status(status).send({ error: message, ...(code ? { code } : {}) });
  });

  configureLicensing(app, opts.licensing);
  registerAuth(app, opts.demo ?? false);
  registerWs(app, opts.authTimeoutMs);
  registerLicensing(app);
  registerCatalog(app);
  registerUsers(app);
  registerSettings(app);
  registerTables(app);
  registerReservations(app);
  registerOrders(app);
  registerKots(app);
  registerPrinters(app, opts.discoverPrinters ?? discoverWindowsPrinters);
  registerBilling(app);
  registerReports(app);
  registerSalesReports(app);
  registerOperationalReports(app);
  registerOrderAnalytics(app);
  registerStock(app);
  registerCosting(app);
  registerGuestOrdering(app, opts.port);
  registerGuestServices(app);
  registerZomato(app, opts.zomatoProvider);
  const cloudBackups = opts.backups ? new CloudBackups(opts.backups, opts.cloudBackupProvider) : undefined;
  if (cloudBackups) {
    app.addHook("onReady", async () => { cloudBackups.start(); });
    app.addHook("preClose", async () => { await cloudBackups.close(); });
  }
  registerSystem(app, opts.backups, opts.port, opts.generation, opts.captainHttps, cloudBackups);

  app.get("/api/health", async () => ({ ok: true, ...(opts.instanceId ? { instanceId: opts.instanceId } : {}) }));

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
    printQueue: PrintQueue;
    enqueuePrint(stationId: string, kind: "kot" | "cancel", label: string, bytes: Buffer): void;
  }
}
