import { uuidv7, openDb, migrate, MIGRATIONS, type Database } from "@forkflow/domain";
import { PrintOutcomeUnknown, type SinkSend, type PrinterTarget } from "./sinks.js";

export interface PrintJobJson {
  id: string;
  printerId: string;
  printerName: string;
  kind: "kot" | "cancel" | "table" | "test" | "receipt" | "credit_note";
  label: string;
  status: "queued" | "printing" | "failed" | "done" | "unknown";
  error: string | null;
  createdAt: number;
  attempts: number;
  copyNumber: number;
  copyCount: number;
}
const KEEP_DONE_JOBS = 100;
// Failed and unknown jobs stay until retried or confirmed, but each holds its full ESC/POS payload (receipts include a QR raster).
const KEEP_UNRESOLVED_JOBS = 200;
interface StoredJob { job_json: string; target_json: string; payload: Buffer }

/** SQLite is the source of truth, including inside a business transaction. */
export class PrintQueue {
  private db: Database;
  private ownsDb: boolean;
  private locks = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(private send: SinkSend, private onChange: (job: PrintJobJson) => void, db?: Database, generation = "initial") {
    this.ownsDb = !db;
    this.db = db ?? openDb(":memory:");
    if (!db) migrate(this.db, MIGRATIONS);
    const previous = this.db.prepare("SELECT generation FROM print_queue_state WHERE id = 1").get() as { generation: string } | undefined;
    const restored = previous !== undefined && previous.generation !== generation;
    // Restored backups may predate a successful send, even for jobs saved as queued.
    for (const row of this.db.prepare("SELECT job_json FROM print_jobs WHERE status = 'printing' OR (? = 1 AND status = 'queued')").all(restored ? 1 : 0) as StoredJob[]) {
      const job = JSON.parse(row.job_json) as PrintJobJson;
      job.status = "unknown";
      job.error = restored ? "Database was restored. Check the paper before retrying this copy." : "Printing was interrupted. Check the paper before retrying this copy.";
      this.save(job);
    }
    this.db.prepare("INSERT INTO print_queue_state (id, generation) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET generation = excluded.generation").run(generation);
  }

  start(): void {
    for (const row of this.db.prepare("SELECT DISTINCT printer_id FROM print_jobs WHERE status = 'queued'").all() as { printer_id: string }[]) {
      this.schedule(row.printer_id);
    }
  }

  enqueue(printer: { id: string; name: string; kind: PrinterTarget["kind"]; connection: string },
    kind: PrintJobJson["kind"], label: string, bytes: Buffer, copies = 1): PrintJobJson {
    if (this.stopped) throw new Error("Print queue is stopping");
    if (!Number.isInteger(copies) || copies < 1 || copies > 5) throw new Error("Copies must be between 1 and 5");
    const jobs = this.db.transaction(() => Array.from({ length: copies }, (_, index) => {
      const job: PrintJobJson = { id: uuidv7(), printerId: printer.id, printerName: printer.name, kind, label,
        status: "queued", error: null, createdAt: Date.now(), attempts: 0, copyNumber: index + 1, copyCount: copies };
      this.db.prepare("INSERT INTO print_jobs (id, printer_id, status, job_json, target_json, payload) VALUES (?, ?, ?, ?, ?, ?)")
        .run(job.id, printer.id, job.status, JSON.stringify(job), JSON.stringify({ kind: printer.kind, connection: printer.connection }), bytes);
      return job;
    }))();
    // I/O waits for the caller's surrounding synchronous transaction to commit.
    queueMicrotask(() => {
      if (this.stopped) return;
      for (const job of jobs) if (this.get(job.id)) this.notify(job);
      this.schedule(printer.id);
    });
    return { ...jobs[0]! };
  }

  retry(jobId: string, checkedPaper = false): PrintJobJson | null {
    if (this.stopped) return null;
    const stored = this.get(jobId);
    if (!stored) return null;
    const job = JSON.parse(stored.job_json) as PrintJobJson;
    if (job.status !== "failed" && !(job.status === "unknown" && checkedPaper)) return null;
    job.status = "queued"; job.error = null; job.attempts += 1;
    this.save(job);
    this.notify(job);
    this.schedule(job.printerId);
    return { ...job };
  }

  jobs(): PrintJobJson[] {
    return (this.db.prepare("SELECT job_json FROM print_jobs ORDER BY sequence DESC").all() as StoredJob[])
      .map(row => JSON.parse(row.job_json) as PrintJobJson);
  }

  confirmPrinted(jobId: string): PrintJobJson | null {
    const stored = this.get(jobId);
    if (!stored) return null;
    const job = JSON.parse(stored.job_json) as PrintJobJson;
    if (job.status !== "unknown") return null;
    job.status = "done"; job.error = "Confirmed on paper";
    this.save(job); this.notify(job);
    return job;
  }

  async close(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.locks.values());
    if (this.ownsDb) this.db.close();
  }

  private get(id: string): StoredJob | undefined {
    return this.db.prepare("SELECT job_json, target_json, payload FROM print_jobs WHERE id = ?").get(id) as StoredJob | undefined;
  }
  private save(job: PrintJobJson): void {
    this.db.prepare("UPDATE print_jobs SET status = ?, job_json = ? WHERE id = ?").run(job.status, JSON.stringify(job), job.id);
  }
  /** Keeps the newest finished jobs, and the newest failed/unknown ones so they stay retryable; older payloads are dropped. */
  private trim(): void {
    const keep = this.db.prepare("DELETE FROM print_jobs WHERE status = ? AND sequence NOT IN (SELECT sequence FROM print_jobs WHERE status = ? ORDER BY sequence DESC LIMIT ?)");
    keep.run("done", "done", KEEP_DONE_JOBS);
    this.db.prepare(`DELETE FROM print_jobs WHERE status IN ('failed', 'unknown')
      AND sequence NOT IN (SELECT sequence FROM print_jobs WHERE status IN ('failed', 'unknown') ORDER BY sequence DESC LIMIT ?)`).run(KEEP_UNRESOLVED_JOBS);
  }
  private notify(job: PrintJobJson): void {
    try { this.onChange({ ...job }); } catch (error) { console.error("Print job notification failed", error); }
  }
  private schedule(printerId: string): void {
    if (this.stopped || this.locks.has(printerId)) return;
    let processingError = false;
    const work = Promise.resolve().then(async () => {
      while (!this.stopped) {
        const row = this.db.prepare("SELECT job_json, target_json, payload FROM print_jobs WHERE printer_id = ? AND status = 'queued' ORDER BY sequence LIMIT 1")
          .get(printerId) as StoredJob | undefined;
        if (!row) break;
        const job = JSON.parse(row.job_json) as PrintJobJson;
        job.status = "printing";
        this.save(job);
        this.notify(job);
        try {
          await this.send(JSON.parse(row.target_json) as PrinterTarget, row.payload);
          job.status = "done"; job.error = null;
        } catch (error) {
          job.status = error instanceof PrintOutcomeUnknown ? "unknown" : "failed";
          job.error = error instanceof Error ? error.message : "Print failed";
        }
        this.save(job);
        this.notify(job);
        this.trim();
      }
    }).catch(error => { processingError = true; console.error("Print queue processing failed", error); }).finally(() => {
      this.locks.delete(printerId);
      if (!this.stopped && !processingError && this.db.prepare("SELECT 1 FROM print_jobs WHERE printer_id = ? AND status = 'queued' LIMIT 1").get(printerId)) this.schedule(printerId);
    });
    this.locks.set(printerId, work);
  }
}
