import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile, type ChildProcess, type ExecFileOptions } from "node:child_process";
import { promises as fsp, readFileSync, existsSync } from "node:fs";
import { realSend, PrintOutcomeUnknown } from "./sinks.js";
import { PrintQueue } from "./queue.js";

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
  it("dispatches validated COM payloads through the Windows helper without opening a filesystem port", async () => {
    const realWriteFile = fsp.writeFile.bind(fsp);
    const write = vi.spyOn(fsp, "writeFile").mockImplementation(async (path, ...rest) => {
      if (String(path).startsWith("\\\\.\\")) throw new Error("test blocked physical COM access");
      return realWriteFile(path, ...rest);
    });
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
      callback(null, "", "");
      return {} as ChildProcess;
    }) as typeof execFile);
    try {
      await realSend({ kind: "bluetooth", connection: "COM10" }, Buffer.from([0, 0x1b, 0xff]));
      expect(execFile).toHaveBeenCalledOnce();
    } finally {
      write.mockRestore();
    }
  });

  it("allows a normal retry after an unsent serial failure", async () => {
    let calls = 0;
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
      if (++calls === 1) callback(Object.assign(new Error("exit 20"), { code: 20 }), "", "NOTSENT: port busy");
      else callback(null, "", "");
      return {} as ChildProcess;
    }) as typeof execFile);
    const queue = new PrintQueue(realSend, () => {});
    try {
      const job = queue.enqueue({ id: "serial", name: "Serial", kind: "bluetooth", connection: "COM10" }, "test", "Test", Buffer.from([0x1b]));
      await vi.waitFor(() => expect(queue.jobs()[0]?.status).toBe("failed"));
      expect(queue.retry(job.id)?.attempts).toBe(1);
      await vi.waitFor(() => expect(queue.jobs()[0]?.status).toBe("done"));
      expect(calls).toBe(2);
    } finally { await queue.close(); }
  });

  it("requires a paper check after an uncertain serial write", async () => {
    let calls = 0;
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
      if (++calls === 1) callback(Object.assign(new Error("exit 21"), { code: 21 }), "", "MAYBESENT: write failed");
      else callback(null, "", "");
      return {} as ChildProcess;
    }) as typeof execFile);
    const queue = new PrintQueue(realSend, () => {});
    try {
      const job = queue.enqueue({ id: "serial", name: "Serial", kind: "bluetooth", connection: "COM10" }, "test", "Test", Buffer.from([0x1b]));
      await vi.waitFor(() => expect(queue.jobs()[0]?.status).toBe("unknown"));
      expect(queue.retry(job.id)).toBeNull();
      expect(queue.retry(job.id, true)?.attempts).toBe(1);
      await vi.waitFor(() => expect(queue.jobs()[0]?.status).toBe("done"));
      expect(calls).toBe(2);
    } finally { await queue.close(); }
  });

  it("releases the per-printer queue lock after a killed helper", async () => {
    let calls = 0;
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
      if (++calls === 1) callback(Object.assign(new Error("timed out"), { code: null, killed: true }), "", "");
      else callback(null, "", "");
      return {} as ChildProcess;
    }) as typeof execFile);
    const queue = new PrintQueue(realSend, () => {});
    try {
      const printer = { id: "serial", name: "Serial", kind: "bluetooth" as const, connection: "COM10" };
      queue.enqueue(printer, "test", "First", Buffer.from([0x1b]));
      queue.enqueue(printer, "test", "Second", Buffer.from([0x1b]));
      await vi.waitFor(() => expect(queue.jobs().map(job => job.status).sort()).toEqual(["done", "unknown"]));
      expect(calls).toBe(2);
    } finally { await queue.close(); }
  });
  it("maps explicit serial pre-write failures to retryable errors and uncertain exits to paper checks", async () => {
    for (const [code, unknown] of [[20, false], [21, true], [1, true], [null, true]] as const) {
      vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
        (args[3] as (error: Error, stdout: string, stderr: string) => void)(Object.assign(new Error("Command failed"), { code, killed: code === null }), "", code === 20 ? "NOTSENT: port busy" : "MAYBESENT: write failed");
        return {} as ChildProcess;
      }) as typeof execFile);
      const error = await realSend({ kind: "bluetooth", connection: "COM9" }, Buffer.from("x")).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof PrintOutcomeUnknown).toBe(unknown);
    }
  });
});
