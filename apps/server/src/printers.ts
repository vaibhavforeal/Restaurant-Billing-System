import { PrinterCreate, PrinterUpdate, uuidv7 } from "@forkflow/domain";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";
import { EscPos } from "./print/escpos.js";
import { readProfile, finishSlip } from "./print/profile.js";
import type { PrinterDiscovery } from "./print/discovery.js";

interface PrinterRow {
  id: string;
  name: string;
  kind: "network" | "windows" | "bluetooth";
  connection: string;
  paper_width: number;
  is_active: number;
  receipt_profile: string;
  kot_profile: string;
}

const toPrinterJson = (r: PrinterRow) => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  connection: r.connection,
  paperWidth: r.paper_width,
  isActive: r.is_active === 1,
  receiptProfile: readProfile(r.receipt_profile),
  kotProfile: readProfile(r.kot_profile),
});

export function registerPrinters(app: FastifyInstance, discover: () => Promise<PrinterDiscovery>): void {
  const read = app.requirePermission("printers.read");
  const manage = app.requirePermission("printers.manage");

  const getPrinter = (id: string) =>
    app.db.prepare("SELECT * FROM printers WHERE id = ?").get(id) as PrinterRow | undefined;

  app.get("/api/printers/discover", { preHandler: manage }, async () => {
    try { return await discover(); }
    catch { throw httpError(503, "Could not list printers on the POS computer. Check Windows Print Spooler and try again, or enter the printer name manually."); }
  });

  app.get("/api/printers", { preHandler: read }, async () => {
    const rows = app.db.prepare("SELECT * FROM printers ORDER BY name").all() as PrinterRow[];
    return { printers: rows.map(toPrinterJson) };
  });

  app.post("/api/printers", { preHandler: manage }, async (req, reply) => {
    const body = PrinterCreate.parse(req.body);
    const id = uuidv7();
    app.db
      .prepare("INSERT INTO printers (id, name, kind, connection, paper_width, receipt_profile, kot_profile) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, body.name, body.kind, body.connection, body.paperWidth, JSON.stringify(body.receiptProfile), JSON.stringify(body.kotProfile));
    return reply.status(201).send({ printer: toPrinterJson(getPrinter(id)!) });
  });

  app.patch("/api/printers/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = PrinterUpdate.parse(req.body);
    const row = getPrinter(id);
    if (!row) throw httpError(404, "printer not found");
    // Only a change to kind/connection is checked against the stricter create rules, so a printer saved
    // under older rules can still be renamed, deactivated, or have its profiles edited.
    if (body.kind !== undefined || body.connection !== undefined) {
      PrinterCreate.parse({ name: body.name ?? row.name, kind: body.kind ?? row.kind, connection: body.connection ?? row.connection, paperWidth: body.paperWidth ?? row.paper_width });
    }

    app.db
      .prepare("UPDATE printers SET name = ?, kind = ?, connection = ?, paper_width = ?, is_active = ?, receipt_profile = ?, kot_profile = ? WHERE id = ?")
      .run(
        body.name ?? row.name,
        body.kind ?? row.kind,
        body.connection ?? row.connection,
        body.paperWidth ?? row.paper_width,
        body.isActive !== undefined ? (body.isActive ? 1 : 0) : row.is_active,
        body.receiptProfile ? JSON.stringify(body.receiptProfile) : row.receipt_profile,
        body.kotProfile ? JSON.stringify(body.kotProfile) : row.kot_profile,
        id,
      );
    return { printer: toPrinterJson(getPrinter(id)!) };
  });

  app.post("/api/printers/:id/test-print", { preHandler: manage }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const printer = getPrinter(id);
    if (!printer) throw httpError(404, "printer not found");
    if (!printer.is_active) throw httpError(409, "Activate the printer before testing it");
    const { profile: profileKind } = z.object({ profile: z.enum(["receipt", "kot"]).default("receipt") }).parse(req.body ?? {});
    const profile = readProfile(profileKind === "receipt" ? printer.receipt_profile : printer.kot_profile);

    const now = new Date();
    const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

    const slip = new EscPos()
      .init()
      .align("center")
      .bold(true)
      .text("TEST PRINT")
      .line()
      .bold(false)
      .text(printer.name)
      .line()
      .text(timeStr)
      .line()
      .line(profileKind === "receipt" ? "BILL PROFILE" : "KOT PROFILE");

    const job = app.printQueue.enqueue(printer, "test", "Test print", finishSlip(slip, profile), profile.copies);
    return reply.status(202).send({ job });
  });

  app.get("/api/print-jobs", { preHandler: read }, async () => {
    const jobs = app.printQueue.jobs();
    return { jobs };
  });

  app.post("/api/print-jobs/:id/retry", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const existing = app.printQueue.jobs().find((j) => j.id === id);
    if (!existing) throw httpError(404, "job not found");
    const body = z.object({ checkedPaper: z.boolean().default(false) }).parse(req.body ?? {});
    if (existing.status !== "failed" && existing.status !== "unknown") throw httpError(409, "job is not failed or interrupted");
    if (existing.status === "unknown" && !body.checkedPaper) throw httpError(409, "Check the paper and confirm before retrying this copy");
    const job = app.printQueue.retry(id, body.checkedPaper);
    return { job: job! };
  });

  app.post("/api/print-jobs/:id/confirm-printed", { preHandler: manage }, async (req) => {
    z.object({ checkedPaper: z.literal(true) }).parse(req.body);
    const job = app.printQueue.confirmPrinted((req.params as { id: string }).id);
    if (!job) throw httpError(409, "Only an uncertain copy can be confirmed as printed");
    return { job };
  });
}
