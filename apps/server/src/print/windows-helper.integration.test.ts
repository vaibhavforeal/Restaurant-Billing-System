import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PrintOutcomeUnknown, realSend } from "./sinks.js";

describe.skipIf(process.platform !== "win32")("Windows RAW helper integration", () => {
  it("reports a randomly named nonexistent printer as safely unsent", async () => {
    const printerName = `ForkFlow-missing-${randomUUID()}`;
    const error = await realSend(
      { kind: "windows", connection: printerName },
      Buffer.from([0x1b, 0x40])
    ).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PrintOutcomeUnknown);
    expect((error as Error).message).toContain(printerName);
  });
});
