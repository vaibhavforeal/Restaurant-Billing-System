import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile, type ChildProcess, type ExecFileOptions } from "node:child_process";
import { promises as fsp, readFileSync, existsSync } from "node:fs";
import { realSend, PrintOutcomeUnknown } from "./sinks.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe("Windows RAW transport", () => {
  it("passes printer names as data and cleans temporary files", async () => {
    const printerName = 'Kitchen "$(`whoami`)" Café';
    let payloadPath = "", scriptPath = "";
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      const options = args[2] as ExecFileOptions;
      const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
      scriptPath = (args[1] as string[]).at(-1)!;
      payloadPath = options.env!["FORKFLOW_PRINT_PAYLOAD"]!;
      const script = readFileSync(scriptPath, "utf8");
      expect(script).not.toContain(printerName);
      expect(script).toContain("$ErrorActionPreference = 'Stop'");
      expect(script).toContain("written != bytes.Length");
      expect(Buffer.from(options.env!["FORKFLOW_PRINT_NAME"]!, "base64").toString("utf8")).toBe(printerName);
      expect(readFileSync(payloadPath).toString()).toBe("receipt bytes");
      expect(options.windowsHide).toBe(true);
      callback(null, "", ""); return {} as ChildProcess;
    }) as typeof execFile);
    await realSend({ kind: "windows", connection: printerName }, Buffer.from("receipt bytes"));
    expect(existsSync(scriptPath)).toBe(false); expect(existsSync(payloadPath)).toBe(false);
  });

  it("does not report success on PowerShell failure", async () => {
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      (args[3] as (error: Error, stdout: string, stderr: string) => void)(new Error("Exit 1"), "", "Spooler rejected data");
      return {} as ChildProcess;
    }) as typeof execFile);
    await expect(realSend({ kind: "windows", connection: "Counter" }, Buffer.from("test"))).rejects.toBeInstanceOf(PrintOutcomeUnknown);
  });

  const failWith = (error: Error & { code?: unknown }, stderr = "") => vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    (args[3] as (error: Error, stdout: string, stderr: string) => void)(error, "", stderr);
    return {} as ChildProcess;
  }) as typeof execFile);
  const exit = (code: unknown) => Object.assign(new Error(`Command failed`), { code });

  it("marks failures that happened before any byte reached the spooler as plain, retryable errors", async () => {
    for (const error of [exit(20), exit(1), exit("ENOENT")]) {
      failWith(error, "NOTSENT: Failed to open printer: Counter");
      const rejected = await realSend({ kind: "windows", connection: "Counter" }, Buffer.from("test")).catch((e: unknown) => e);
      expect(rejected).toBeInstanceOf(Error);
      expect(rejected).not.toBeInstanceOf(PrintOutcomeUnknown);
    }
    failWith(exit(20), "NOTSENT: Failed to open printer: Counter");
    await expect(realSend({ kind: "windows", connection: "Counter" }, Buffer.from("test"))).rejects.toThrow("Windows printer was not reached: Failed to open printer: Counter");
  });

  it("keeps write-stage failures and timeouts as unknown outcomes", async () => {
    for (const error of [exit(21), Object.assign(exit(null), { killed: true })]) {
      failWith(error, "WritePrinter failed");
      await expect(realSend({ kind: "windows", connection: "Counter" }, Buffer.from("test"))).rejects.toBeInstanceOf(PrintOutcomeUnknown);
    }
  });
});

describe("Bluetooth transport", () => {
  it("treats a port that cannot be opened as a failure and any later write error as unknown", async () => {
    const write = vi.spyOn(fsp, "writeFile");
    write.mockRejectedValueOnce(Object.assign(new Error("ENOENT: no such file"), { syscall: "open", code: "ENOENT" }));
    const missing = await realSend({ kind: "bluetooth", connection: "COM9" }, Buffer.from("x")).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(Error);
    expect(missing).not.toBeInstanceOf(PrintOutcomeUnknown);
    write.mockRejectedValueOnce(Object.assign(new Error("EIO"), { syscall: "write", code: "EIO" }));
    await expect(realSend({ kind: "bluetooth", connection: "COM9" }, Buffer.from("x"))).rejects.toBeInstanceOf(PrintOutcomeUnknown);
    write.mockRestore();
  });
});
