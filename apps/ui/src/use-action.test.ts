import { describe, expect, it } from "vitest";
import { actionRunner } from "./use-action";

describe("actionRunner", () => {
  const setup = () => {
    const seen: { busy: boolean[]; error: string[] } = { busy: [], error: [] };
    return { seen, run: actionRunner((b) => seen.busy.push(b), (e) => seen.error.push(e)) };
  };

  it("runs one action at a time, so a double click sends one request", async () => {
    const { run, seen } = setup();
    let calls = 0, release!: () => void;
    const first = run(() => { calls++; return new Promise<void>((r) => { release = r; }); });
    expect(await run(async () => { calls++; })).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(calls).toBe(1);
    expect(seen.busy).toEqual([true, false]);
    expect(await run(async () => { calls++; })).toBe(true); // free again afterwards
  });

  it("clears the last error, and shows a thrown one in words or the fallback", async () => {
    const { run, seen } = setup();
    expect(await run(async () => { throw new Error("Printer is offline"); }, "Test print failed")).toBe(false);
    expect(await run(async () => { throw "not an Error"; }, "Test print failed")).toBe(false);
    expect(seen.error).toEqual(["", "Printer is offline", "", "Test print failed"]);
    expect(seen.busy.at(-1)).toBe(false);
  });
});
