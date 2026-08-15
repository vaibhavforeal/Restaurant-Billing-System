import { describe, it, expect } from "vitest";
import { PrintQueue } from "./queue.js";
import { makeFakeSink } from "./sinks.js";

describe("PrintQueue", () => {
  it("processes job through queued → printing → done", async () => {
    const fake = makeFakeSink();
    const changes: string[] = [];
    const queue = new PrintQueue(fake.send, (job) => changes.push(job.status));

    const printer = { id: "p1", name: "Printer 1", kind: "network" as const, connection: "192.168.1.1" };
    const job = queue.enqueue(printer, "test", "Test print", Buffer.from("data"));

    expect(job.status).toBe("queued");

    // Wait for async processing
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(changes).toEqual(["queued", "printing", "done"]);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.bytes.toString()).toBe("data");
  });

  it("handles failure and records error", async () => {
    const fake = makeFakeSink();
    fake.failNext("printer offline");

    const changes: Array<{ status: string; error: string | null }> = [];
    const queue = new PrintQueue(fake.send, (job) => changes.push({ status: job.status, error: job.error }));

    const printer = { id: "p1", name: "Printer 1", kind: "network" as const, connection: "test" };
    queue.enqueue(printer, "test", "Test", Buffer.from("data"));

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(changes[changes.length - 1]).toEqual({ status: "failed", error: "printer offline" });
  });

  it("retries a failed job", async () => {
    const fake = makeFakeSink();
    fake.failNext("first fail");

    const queue = new PrintQueue(fake.send, () => {});
    const printer = { id: "p1", name: "Printer 1", kind: "network" as const, connection: "test" };
    const job = queue.enqueue(printer, "test", "Test", Buffer.from("retry"));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(job.status).toBe("queued"); // Initial status

    const jobs = queue.jobs();
    const failed = jobs.find((j) => j.id === job.id)!;
    expect(failed.status).toBe("failed");

    const retried = queue.retry(job.id);
    expect(retried).not.toBeNull();
    expect(retried!.attempts).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const final = queue.jobs().find((j) => j.id === job.id)!;
    expect(final.status).toBe("done");
    expect(fake.sent).toHaveLength(1);
  });

  it("serializes jobs per printer", async () => {
    const fake = makeFakeSink();
    const order: string[] = [];

    // Create controlled promises
    let resolve1: () => void;
    let resolve2: () => void;
    const promise1 = new Promise<void>((r) => { resolve1 = r; });
    const promise2 = new Promise<void>((r) => { resolve2 = r; });

    let callCount = 0;
    const controlledSend: typeof fake.send = async (target, bytes) => {
      callCount++;
      if (callCount === 1) {
        order.push("job1-start");
        await promise1;
        order.push("job1-end");
      } else if (callCount === 2) {
        order.push("job2-start");
        await promise2;
        order.push("job2-end");
      }
    };

    const queue = new PrintQueue(controlledSend, () => {});
    const printer = { id: "p1", name: "Printer 1", kind: "network" as const, connection: "test" };

    queue.enqueue(printer, "test", "Job 1", Buffer.from("1"));
    queue.enqueue(printer, "test", "Job 2", Buffer.from("2"));

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["job1-start"]);

    resolve1!();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["job1-start", "job1-end", "job2-start"]);

    resolve2!();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["job1-start", "job1-end", "job2-start", "job2-end"]);
  });

  it("caps job history at 100", () => {
    const fake = makeFakeSink();
    const queue = new PrintQueue(fake.send, () => {});
    const printer = { id: "p1", name: "Printer 1", kind: "network" as const, connection: "test" };

    for (let i = 0; i < 105; i++) {
      queue.enqueue(printer, "test", `Job ${i}`, Buffer.from("data"));
    }

    expect(queue.jobs()).toHaveLength(100);
  });

  it("returns null when retrying non-failed job", () => {
    const fake = makeFakeSink();
    const queue = new PrintQueue(fake.send, () => {});
    const printer = { id: "p1", name: "Printer 1", kind: "network" as const, connection: "test" };
    const job = queue.enqueue(printer, "test", "Test", Buffer.from("data"));

    const result = queue.retry(job.id);
    expect(result).toBeNull();
  });
});
