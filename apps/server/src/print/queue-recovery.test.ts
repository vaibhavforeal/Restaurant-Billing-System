import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, migrate, openDb, type Database } from "@forkflow/domain";
import { PrintQueue } from "./queue.js";
import { makeFakeSink, PrintOutcomeUnknown } from "./sinks.js";

const printer = { id: "counter", name: "Counter", kind: "network" as const, connection: "127.0.0.1:9100" };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
const readyDb = () => { const db = openDb(":memory:"); migrate(db, MIGRATIONS); cleanup.push(() => { db.close(); }); return db; };
const queueFor = (db: Database, fake = makeFakeSink()) => {
  const queue = new PrintQueue(fake.send, () => {}, db); cleanup.push(() => queue.close()); return { queue, fake };
};

describe("durable print jobs", () => {
  it("holds queued jobs from restored backups and can confirm paper without resending", async () => {
    const db = readyDb();
    const original = new PrintQueue(makeFakeSink().send, () => {}, db, "before-restore");
    const job = original.enqueue(printer, "kot", "Old KOT", Buffer.from("old"));
    await original.close();
    const fake = makeFakeSink();
    const restored = new PrintQueue(fake.send, () => {}, db, "after-restore");
    cleanup.push(() => restored.close());
    restored.start();
    await Promise.resolve();
    expect(restored.jobs()[0]?.status).toBe("unknown");
    expect(restored.confirmPrinted(job.id)?.error).toBe("Confirmed on paper");
    expect(restored.retry(job.id, true)).toBeNull();
    expect(fake.sent).toHaveLength(0);
  });

  it("survives a database reopen and only automatically resumes copies never started", async () => {
    const directory = mkdtempSync(join(tmpdir(), "forkflow-print-recovery-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, "test.db");
    let db = openDb(file); migrate(db, MIGRATIONS);
    const first = new PrintQueue(makeFakeSink().send, () => {}, db);
    first.enqueue(printer, "receipt", "Bill #1", Buffer.from("saved receipt"), 3);
    await first.close(); // Leaves all three queued before the deferred worker starts.
    const jobs = first.jobs();
    for (const [index, status] of [[0, "printing"], [1, "failed"]] as const) {
      const job = { ...jobs[index]!, status };
      db.prepare("UPDATE print_jobs SET status = ?, job_json = ? WHERE id = ?").run(status, JSON.stringify(job), job.id);
    }
    db.close();
    db = openDb(file); cleanup.push(() => { db.close(); });
    const { queue, fake } = queueFor(db);
    queue.start();
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(queue.jobs().map(job => job.status).sort()).toEqual(["done", "failed", "unknown"]);
    expect(fake.sent[0]!.bytes.toString()).toBe("saved receipt");
    expect(queue.retry(jobs[0]!.id)).toBeNull();
    expect(queue.retry(jobs[0]!.id, true)?.copyNumber).toBe(jobs[0]!.copyNumber);
    await vi.waitFor(() => expect(fake.sent).toHaveLength(2));
    expect(queue.jobs().find(job => job.id === jobs[1]!.id)?.status).toBe("failed");
  });

  it("rolls jobs back with the business transaction and emits no phantom notification", async () => {
    const db = readyDb(), fake = makeFakeSink(), changes = vi.fn();
    const queue = new PrintQueue(fake.send, changes, db); cleanup.push(() => queue.close());
    expect(() => db.transaction(() => {
      queue.enqueue(printer, "kot", "KOT #2", Buffer.from("must not print"), 2);
      throw new Error("business write failed");
    })()).toThrow("business write failed");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(queue.jobs()).toEqual([]); expect(fake.sent).toEqual([]); expect(changes).not.toHaveBeenCalled();
  });

  it("records ambiguous transport outcomes and retries only the chosen frozen copy", async () => {
    const db = readyDb(); let count = 0;
    const received: string[] = [];
    const queue = new PrintQueue(async (_target, bytes) => {
      received.push(bytes.toString());
      if (++count === 2) throw new PrintOutcomeUnknown("Write interrupted");
    }, () => {}, db); cleanup.push(() => queue.close());
    queue.enqueue(printer, "receipt", "Bill #3", Buffer.from("original"), 3);
    await vi.waitFor(() => expect(queue.jobs().map(job => job.status)).toEqual(["done", "unknown", "done"]));
    const uncertain = queue.jobs()[1]!;
    queue.retry(uncertain.id, true);
    await vi.waitFor(() => expect(received).toHaveLength(4));
    expect(received).toEqual(["original", "original", "original", "original"]);
    expect(queue.jobs().find(job => job.id === uncertain.id)?.attempts).toBe(1);
  });
});
