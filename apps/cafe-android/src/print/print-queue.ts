import type { PrintTarget } from "@masalapos/cafe-data";

export type { PrintTarget };

export interface PrintJob { id: string; label: string; target: PrintTarget; bytes: Uint8Array; copies: number }
export type QueuedJob = PrintJob & { state: "queued" | "printing" | "done" | "failed"; error: string | null };

const MESSAGES: Record<string, string> = {
  PRINTER_UNREACHABLE: "Could not reach the printer. Check it is switched on and nearby.",
  BLUETOOTH_OFF: "Bluetooth is off. Turn it on and try again.",
  NO_PERMISSION: "MasalaPOS Cafe needs permission to use Bluetooth printers.",
  WRITE_FAILED: "The printer stopped responding. Check paper and try again.",
};

export function printErrorMessage(code: string): string {
  return MESSAGES[code] ?? "The receipt did not print. Try again.";
}

const errorCode = (e: unknown) => (typeof e === "object" && e !== null && "code" in e && typeof e.code === "string" ? e.code : "");

/**
 * Sends print jobs to the printer one at a time, in order. The bill is saved before its job is queued, so a failed
 * job only needs Try again; it never loses a sale.
 */
export function createPrintQueue(send: (target: PrintTarget, bytes: Uint8Array) => Promise<void>) {
  let jobs: QueuedJob[] = [];
  let running = false;
  const listeners = new Set<() => void>();
  const notify = () => { for (const fn of [...listeners]) fn(); };
  const update = (id: string, change: Partial<QueuedJob>) => {
    jobs = jobs.map((j) => (j.id === id ? { ...j, ...change } : j));
    notify();
  };

  /** Starts sending on the next microtask, so a caller sees its job as queued first. */
  const kick = () => { void Promise.resolve().then(pump); };

  async function pump() {
    if (running) return;
    running = true;
    try {
      for (let next = jobs.find((j) => j.state === "queued"); next; next = jobs.find((j) => j.state === "queued")) {
        const job = next;
        update(job.id, { state: "printing", error: null });
        try {
          for (let copy = 0; copy < job.copies; copy++) await send(job.target, job.bytes);
          update(job.id, { state: "done" });
        } catch (e) {
          update(job.id, { state: "failed", error: printErrorMessage(errorCode(e)) });
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    enqueue(job: PrintJob) {
      jobs = [...jobs.filter((j) => j.id !== job.id), { ...job, state: "queued", error: null }];
      notify();
      kick();
    },
    retry(id: string) {
      if (!jobs.some((j) => j.id === id && j.state === "failed")) return;
      update(id, { state: "queued", error: null });
      kick();
    },
    dismiss(id: string) {
      jobs = jobs.filter((j) => j.id !== id);
      notify();
    },
    jobs(): readonly QueuedJob[] { return jobs; },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

export type PrintQueue = ReturnType<typeof createPrintQueue>;
