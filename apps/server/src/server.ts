import { registerAi, type AiOptions } from "./ai/routes.js";
import { registerStaffActivity } from "./staff-activity.js";
import { registerPrepForecast } from "./prep-forecast.js";
import type { Database } from "@masalapos/domain";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { ZodError } from "zod";
import { registerAuth } from "./auth.js";
import { registerWs } from "./ws.js";
import { registerCatalog } from "./catalog.js";
import { registerUsers } from "./users.js";
import { registerSettings } from "./settings.js";
import { registerOrderSettings } from "./order-settings.js";
import { registerMenuInsights } from "./menu-insights.js";
import { registerDiscountCaps } from "./discount-caps.js";
import { registerKotEdits } from "./kot-edit.js";
import { registerOrderTypes } from "./order-types.js";
import { registerOrderSummary } from "./order-summary.js";
import { registerItemTransfers } from "./item-transfers.js";
import { registerAddonGroups } from "./addon-groups.js";
import { registerShifts } from "./shifts.js";
import { registerCustomers } from "./customers.js";
import { registerLoyaltyTiers } from "./loyalty.js";
import { registerFeedback } from "./feedback.js";
import { registerCustomerSegments } from "./customer-segments.js";
import { registerCrmReports } from "./crm-reports.js";
import { registerUpdates, type UpdateBridge } from "./updates.js";
import { registerTables } from "./tables.js";
import { registerReservations } from "./reservations.js";
import { registerOrders } from "./orders.js";
import { registerKots } from "./kots.js";
import { registerTableTransfer } from "./table-transfer.js";
import { registerPrinters } from "./printers.js";
import { registerBilling } from "./billing.js";
import { registerOffers } from "./offers.js";
import { registerCreditNotes } from "./credit-notes.js";
import { registerZomatoDesk } from "./zomato-desk.js";
import { registerReports } from "./reports.js";
import { registerSalesReports } from "./sales-reports.js";
import { registerOperationalReports } from "./operational-reports.js";
import { registerGstReturns } from "./gst-returns.js";
import { registerCustomReports } from "./custom-reports.js";
import { registerOrderAnalytics } from "./order-analytics.js";
import { registerDashboard } from "./dashboard.js";
import { registerStock } from "./stock.js";
import { registerCosting } from "./costing.js";
import { registerGuestOrdering } from "./guest-ordering.js";
import { registerGuestServices } from "./guest-services.js";
import { registerSystem } from "./system.js";
import type { Backups } from "./backups.js";
import { CloudBackups, type CloudBackupProvider } from "./cloud-backups.js";
import { RestoreStaging } from "./restore-staging.js";
import { realSend, type SinkSend } from "./print/sinks.js";
import { PrintQueue } from "./print/queue.js";
import { discoverWindowsPrinters, type PrinterDiscovery } from "./print/discovery.js";
import { configureLicensing, registerLicensing, type LicensingOptions } from "./licensing.js";
import { configureDevices } from "./devices.js";
import { registerSupport, type SupportOptions } from "./support.js";
import { provideModuleAllowances, registerModules } from "./modules.js";
import type { CaptainHttpsInfo } from "./captain-https.js";
import { registerIntegrations } from "./integrations.js";
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
  /** Message port to the desktop shell's updater; absent outside the desktop app. */
  updateBridge?: UpdateBridge;
  /** The running app version, shown in Settings → Updates. */
  appVersion?: string;
  /** The AI assistant's data folder and sealing key (absent in demo mode; tests pass a fake fetch and base URL). */
  ai?: AiOptions;
  /** Tests replace the support channel's live connection. */
  support?: Pick<SupportOptions, "connect" | "log">;
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
    const code = typeof err === "object" && err !== null && "code" in err && (err.code === "menu_changed" || err.code === "kds_off" || err.code === "integration_off" || err.code === "module_off" || err.code === "zomato_duplicate" || err.code === "zomato_status" || err.code === "zomato_order" || err.code === "discount_cap" || err.code === "day_open" || err.code === "orders_open" || err.code === "combo_picks" || err.code === "combo_item" || err.code === "addon_picks" || err.code === "addon_only" || err.code === "addon_line" || err.code === "offer_used") ? err.code : undefined;
    return reply.status(status).send({ error: message, ...(code ? { code } : {}) });
  });

  configureDevices(app, opts.licensing?.now);
  configureLicensing(app, opts.licensing, opts.appVersion);
  provideModuleAllowances(app.db, () => app.licensing.status().modules);
  registerAuth(app, opts.demo ?? false);
  registerWs(app, opts.authTimeoutMs);
  registerLicensing(app);
  registerSupport(app, {
    ...(opts.licensing?.serviceUrl && opts.licensing.installationSecret
      ? { serviceUrl: opts.licensing.serviceUrl, installationId: opts.licensing.installationId, installationSecret: opts.licensing.installationSecret } : {}),
    ...(opts.updateBridge ? { desktop: opts.updateBridge } : {}),
    ...(opts.licensing?.fetch ? { fetch: opts.licensing.fetch } : {}),
    ...opts.support,
  });
  registerCatalog(app);
  registerUsers(app);
  registerSettings(app);
  registerStaffActivity(app);
  // The AI assistant reaches MasalaPOS's AI service the same way support does: with the counter's installation ID and secret.
  const aiService = opts.ai?.service ?? (opts.licensing?.serviceUrl && opts.licensing.installationSecret
    ? { serviceUrl: opts.licensing.serviceUrl, installationId: opts.licensing.installationId, installationSecret: opts.licensing.installationSecret } : undefined);
  const aiFetch = opts.ai?.fetch ?? opts.licensing?.fetch;
  registerAi(app, opts.ai && { dataDir: opts.ai.dataDir, ...(aiService ? { service: aiService } : {}), ...(aiFetch ? { fetch: aiFetch } : {}) });
  registerOrderSettings(app);
  registerMenuInsights(app);
  registerDiscountCaps(app);
  registerKotEdits(app);
  registerOrderTypes(app);
  registerOrderSummary(app);
  registerItemTransfers(app);
  registerAddonGroups(app);
  registerShifts(app);
  registerCustomers(app);
  registerLoyaltyTiers(app);
  registerCustomerSegments(app);
  registerUpdates(app, opts.updateBridge, opts.appVersion ?? "development");
  registerTables(app);
  registerReservations(app);
  registerOrders(app);
  registerKots(app);
  registerTableTransfer(app);
  registerPrinters(app, opts.discoverPrinters ?? discoverWindowsPrinters);
  registerBilling(app);
  registerOffers(app);
  registerCreditNotes(app);
  registerZomatoDesk(app);
  registerReports(app);
  registerSalesReports(app);
  registerOperationalReports(app);
  registerGstReturns(app);
  registerCustomReports(app);
  registerCrmReports(app);
  registerOrderAnalytics(app);
  registerDashboard(app);
  registerStock(app);
  registerPrepForecast(app);
  registerCosting(app);
  registerGuestOrdering(app, opts.port);
  registerFeedback(app, opts.port);
  registerGuestServices(app);
  registerModules(app);
  registerIntegrations(app);
  registerZomato(app, opts.zomatoProvider);
  const cloudBackups = opts.backups ? new CloudBackups(opts.backups, opts.cloudBackupProvider) : undefined;
  if (cloudBackups) {
    app.addHook("onReady", async () => { cloudBackups.start(); });
    app.addHook("preClose", async () => { await cloudBackups.close(); });
  }
  const staging = opts.backups && opts.updateBridge ? new RestoreStaging(opts.backups.dataDir) : undefined;
  registerSystem(app, opts.backups, opts.port, opts.generation, opts.captainHttps, cloudBackups, { ...(staging ? { staging } : {}), ...(opts.updateBridge ? { desktop: opts.updateBridge } : {}) });

  app.get("/api/health", async () => ({ ok: true, ...(opts.instanceId ? { instanceId: opts.instanceId } : {}) }));

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
    printQueue: PrintQueue;
  }
}
