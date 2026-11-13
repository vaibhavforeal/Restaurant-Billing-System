import { describe, expect, it } from "vitest";
import { createPrintQueue, printErrorMessage, type PrintJob, type PrintTarget } from "./print-queue";

const target: PrintTarget = { transport: "bluetooth", address: "AA:BB:CC:DD:EE:FF" };
const job = (id: string, copies = 1): PrintJob => ({ id, label: `Bill ${id}`, target, bytes: Uint8Array.from([1, 2, 3]), copies });
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A fake printer: each send waits until the test resolves or rejects it. */
function fakeSend() {
  const calls: Array<{ bytes: Uint8Array; resolve: () => void; reject: (e: unknown) => void }> = [];
  const send = (_t: PrintTarget, bytes: Uint8Array) => new Promise<void>((resolve, reject) => { calls.push({ bytes, resolve, reject }); });
  return { send, calls };
}
const states = (q: ReturnType<typeof createPrintQueue>) => q.jobs().map((j) => `${j.id}:${j.state}`);

describe("print queue", () => {
  it("sends jobs one at a time, in order", async () => {
    const { send, calls } = fakeSend();
    const q = createPrintQueue(send);
    q.enqueue(job("a")); q.enqueue(job("b"));
    await settle();
    expect(calls).toHaveLength(1);
    expect(states(q)).toEqual(["a:printing", "b:queued"]);
    calls[0]!.resolve(); await settle();
    expect(calls).toHaveLength(2);
    calls[1]!.resolve(); await settle();
    expect(states(q)).toEqual(["a:done", "b:done"]);
  });

  it("sends a job once per copy", async () => {
    const { send, calls } = fakeSend();
    const q = createPrintQueue(send);
    q.enqueue(job("a", 2));
    await settle(); calls[0]!.resolve(); await settle(); calls[1]!.resolve(); await settle();
    expect(calls.map((c) => [...c.bytes])).toEqual([[1, 2, 3], [1, 2, 3]]);
    expect(states(q)).toEqual(["a:done"]);
  });

  it("marks a failed job, keeps its message and carries on with the next", async () => {
    const { send, calls } = fakeSend();
    const q = createPrintQueue(send);
    q.enqueue(job("a")); q.enqueue(job("b"));
    await settle(); calls[0]!.reject({ code: "BLUETOOTH_OFF" }); await settle();
    calls[1]!.resolve(); await settle();
    expect(q.jobs()[0]).toMatchObject({ id: "a", state: "failed", error: printErrorMessage("BLUETOOTH_OFF") });
    expect(q.jobs()[0]!.error).toBe("Bluetooth is off. Turn it on and try again.");
    expect(states(q)).toEqual(["a:failed", "b:done"]);
  });

  it("prints a failed job again on retry", async () => {
    const { send, calls } = fakeSend();
    const q = createPrintQueue(send);
    q.enqueue(job("a"));
    await settle(); calls[0]!.reject(new Error("socket closed")); await settle();
    expect(q.jobs()[0]).toMatchObject({ state: "failed", error: "The receipt did not print. Try again." });
    q.retry("a");
    expect(states(q)).toEqual(["a:queued"]);
    await settle(); calls[1]!.resolve(); await settle();
    expect(q.jobs()[0]).toMatchObject({ state: "done", error: null });
  });

  it("forgets a dismissed job and tells subscribers on every change", async () => {
    const { send, calls } = fakeSend();
    const q = createPrintQueue(send);
    let changes = 0;
    const stop = q.subscribe(() => { changes++; });
    q.enqueue(job("a"));
    await settle(); calls[0]!.resolve(); await settle();
    q.dismiss("a");
    expect(q.jobs()).toEqual([]);
    expect(changes).toBeGreaterThan(0);
    const seen = changes;
    stop();
    q.enqueue(job("b"));
    expect(changes).toBe(seen);
  });

  it.each([["PRINTER_UNREACHABLE", "Could not reach the printer. Check it is switched on and nearby."],
    ["NO_PERMISSION", "MasalaPOS Cafe needs permission to use Bluetooth printers."],
    ["WRITE_FAILED", "The printer stopped responding. Check paper and try again."],
    ["SOMETHING_ELSE", "The receipt did not print. Try again."]])("explains %s", (code, text) => expect(printErrorMessage(code)).toBe(text));
});
