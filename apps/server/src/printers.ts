import { PrinterCreate, PrinterUpdate, StationCreate, StationUpdate, uuidv7 } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";
import { EscPos } from "./print/escpos.js";

interface PrinterRow {
  id: string;
  name: string;
  kind: "network" | "windows" | "bluetooth";
  connection: string;
  paper_width: number;
  is_active: number;
}

const toPrinterJson = (r: PrinterRow) => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  connection: r.connection,
  paperWidth: r.paper_width,
  isActive: r.is_active === 1,
});

export function registerPrinters(app: FastifyInstance): void {
  const read = app.requirePermission("printers.read");
  const manage = app.requirePermission("printers.manage");

  const getPrinter = (id: string) =>
    app.db.prepare("SELECT * FROM printers WHERE id = ?").get(id) as PrinterRow | undefined;

  app.get("/api/printers", { preHandler: read }, async () => {
    const rows = app.db.prepare("SELECT * FROM printers ORDER BY name").all() as PrinterRow[];
    return { printers: rows.map(toPrinterJson) };
  });

  app.post("/api/printers", { preHandler: manage }, async (req, reply) => {
    const body = PrinterCreate.parse(req.body);
    const id = uuidv7();
    app.db
      .prepare("INSERT INTO printers (id, name, kind, connection, paper_width) VALUES (?, ?, ?, ?, ?)")
      .run(id, body.name, body.kind, body.connection, body.paperWidth);
    return reply.status(201).send({ printer: toPrinterJson(getPrinter(id)!) });
  });

  app.patch("/api/printers/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = PrinterUpdate.parse(req.body);
    const row = getPrinter(id);
    if (!row) throw httpError(404, "printer not found");

    app.db
      .prepare("UPDATE printers SET name = ?, kind = ?, connection = ?, paper_width = ?, is_active = ? WHERE id = ?")
      .run(
        body.name ?? row.name,
        body.kind ?? row.kind,
        body.connection ?? row.connection,
        body.paperWidth ?? row.paper_width,
        body.isActive !== undefined ? (body.isActive ? 1 : 0) : row.is_active,
        id,
      );
    return { printer: toPrinterJson(getPrinter(id)!) };
  });

  app.post("/api/printers/:id/test-print", { preHandler: manage }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const printer = getPrinter(id);
    if (!printer) throw httpError(404, "printer not found");

    const now = new Date();
    const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

    const bytes = new EscPos()
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
      .feed(3)
      .cut()
      .bytes();

    const job = app.printQueue.enqueue(printer, "test", "Test print", bytes);
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
    if (existing.status !== "failed") throw httpError(409, "job is not failed");
    const job = app.printQueue.retry(id);
    return { job: job! };
  });
}
