import { uuidv7 } from "@forkflow/domain";
import type { SinkSend, PrinterTarget } from "./sinks.js";

export interface PrintJobJson {
  id: string;
  printerId: string;
  printerName: string;
  kind: "kot" | "cancel" | "test" | "receipt";
  label: string;
  status: "queued" | "printing" | "failed" | "done";
  error: string | null;
  createdAt: number;
  attempts: number;
}

interface QueuedJob {
  json: PrintJobJson;
  target: PrinterTarget;
  bytes: Buffer;
}

export class PrintQueue {
  private jobsList: QueuedJob[] = [];
  private perPrinterLock = new Map<string, Promise<void>>();

  constructor(
    private send: SinkSend,
    private onChange: (job: PrintJobJson) => void,
  ) {}

  enqueue(
    printer: { id: string; name: string; kind: "network" | "windows" | "bluetooth"; connection: string },
    kind: "kot" | "cancel" | "test" | "receipt",
    label: string,
    bytes: Buffer,
  ): PrintJobJson {
    const job: QueuedJob = {
      json: {
        id: uuidv7(),
        printerId: printer.id,
        printerName: printer.name,
        kind,
        label,
        status: "queued",
        error: null,
        createdAt: Date.now(),
        attempts: 0,
      },
      target: { kind: printer.kind, connection: printer.connection },
      bytes,
    };

    this.jobsList.unshift(job);
    this.trimCompleted();

    const snap = { ...job.json };
    this.onChange(snap);
    this.processQueue(printer.id);

    return snap;
  }

  retry(jobId: string): PrintJobJson | null {
    const job = this.jobsList.find((j) => j.json.id === jobId);
    if (!job || job.json.status !== "failed") return null;

    job.json.status = "queued";
    job.json.error = null;
    job.json.attempts += 1;
    const snap = { ...job.json };
    this.onChange(snap);
    this.processQueue(job.json.printerId);

    return snap;
  }

  jobs(): PrintJobJson[] {
    return this.jobsList.map((j) => ({ ...j.json }));
  }

  private trimCompleted() {
    // Keep every live/failed job; only successful history may be discarded.
    let completed = 0;
    this.jobsList = this.jobsList.filter((job) => job.json.status !== "done" || ++completed <= 100);
  }

  private async processQueue(printerId: string): Promise<void> {
    const existing = this.perPrinterLock.get(printerId);
    if (existing) {
      // Already processing this printer's queue
      return;
    }

    const work = (async () => {
      while (true) {
        // Find the OLDEST queued job for this printer (scan from end)
        let job: QueuedJob | undefined;
        for (let i = this.jobsList.length - 1; i >= 0; i--) {
          const candidate = this.jobsList[i];
          if (candidate!.json.printerId === printerId && candidate!.json.status === "queued") {
            job = candidate;
            break;
          }
        }
        if (!job) break;

        try {
          job.json.status = "printing";
          this.onChange({ ...job.json });

          try {
            await this.send(job.target, job.bytes);
            job.json.status = "done";
            job.json.error = null;
          } catch (err) {
            job.json.status = "failed";
            job.json.error = err instanceof Error ? err.message : "unknown error";
          }

          this.onChange({ ...job.json });
          this.trimCompleted();
        } catch (onChangeErr) {
          // Defensive: if onChange throws, log but don't wedge the printer
          console.error("onChange threw:", onChangeErr);
        }
      }
    })();

    this.perPrinterLock.set(printerId, work);
    try {
      await work;
    } finally {
      this.perPrinterLock.delete(printerId);
    }

    // Re-check for newly queued jobs that may have arrived during final await
    const hasMore = this.jobsList.some(
      (j) => j.json.printerId === printerId && j.json.status === "queued"
    );
    if (hasMore) this.processQueue(printerId);
  }
}
