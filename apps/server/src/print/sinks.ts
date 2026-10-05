import net from "node:net";
import { networkPrinterAddress } from "@forkflow/domain";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The transport accepted some or all of the bytes, or may have: staff must check the paper before retrying. */
export class PrintOutcomeUnknown extends Error {}

// Exit codes from the Windows helper script. 1 is PowerShell's own failure before the helper ran (compile or file read).
const EXIT_NOT_SENT = 20;
const EXIT_MAYBE_SENT = 21;

/** Only failures that provably happened before any byte reached the spooler are plain, safely retryable errors. */
function windowsFailure(error: Error & { code?: unknown; killed?: boolean }, stderr: string): Error {
  const message = (stderr || error.message).trim();
  if (error.code === "ENOENT" || error.code === 1 || error.code === EXIT_NOT_SENT) {
    return new Error(`Windows printer was not reached: ${message.replace(/^NOTSENT:\s*/, "")}`);
  }
  return new PrintOutcomeUnknown(`Windows printer submission was not confirmed: ${message}`);
}

export interface PrinterTarget {
  kind: "network" | "windows" | "bluetooth";
  connection: string;
}

export type SinkSend = (target: PrinterTarget, bytes: Buffer) => Promise<void>;

/**
 * Real print sink dispatcher. Sends bytes to printer via the appropriate transport.
 * Rejects with descriptive error on failure.
 */
export const realSend: SinkSend = async (target, bytes) => {
  if (target.kind === "network") {
    return sendToNetwork(target.connection, bytes);
  } else if (target.kind === "windows") {
    return sendToWindows(target.connection, bytes);
  } else if (target.kind === "bluetooth") {
    return sendToBluetooth(target.connection, bytes);
  }
  throw new Error(`Unknown printer kind: ${(target as PrinterTarget).kind}`);
};

async function sendToNetwork(connection: string, bytes: Buffer): Promise<void> {
  const { host, port } = networkPrinterAddress(connection);

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let timedOut = false;
    let writing = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      socket.destroy();
      reject(new (writing ? PrintOutcomeUnknown : Error)(`Network printer timeout: ${connection}`));
    }, 5000);

    socket.on("error", (err) => {
      clearTimeout(timeout);
      if (!timedOut) reject(new (writing ? PrintOutcomeUnknown : Error)(`Network printer error: ${err.message}`));
    });

    socket.connect(port, host, () => {
      writing = true;
      socket.write(bytes, (err) => {
        if (err && !timedOut) {
          clearTimeout(timeout);
          socket.destroy();
          reject(new PrintOutcomeUnknown(`Write failed: ${err.message}`));
        } else if (!err && !timedOut) {
          socket.end(() => {
            clearTimeout(timeout);
            resolve();
          });
        }
      });
    });
  });
}

async function sendToWindows(printerName: string, bytes: Buffer): Promise<void> {
  const directory = await fs.mkdtemp(join(tmpdir(), "forkflow-print-"));
  const bytesPath = join(directory, "payload.bin");
  const scriptPath = join(directory, "send.ps1");
  try {
    await fs.writeFile(bytesPath, bytes);

  // Embedded PowerShell script with RawPrinterHelper
  const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;

public class RawPrinterHelper {
    [StructLayout(LayoutKind.Sequential)]
    public struct DOCINFO {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }

    [DllImport("winspool.Drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);

    [DllImport("winspool.Drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern int StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFO pDocInfo);

    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);

    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    public static void SendBytesToPrinter(string printerName, byte[] bytes) {
        IntPtr hPrinter = IntPtr.Zero;
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) {
            throw new Exception("NOTSENT: Failed to open printer: " + printerName);
        }
        try {
            DOCINFO di = new DOCINFO();
            di.pDocName = "ForkFlow Print Job";
            di.pDataType = "RAW";
            if (StartDocPrinter(hPrinter, 1, ref di) == 0) {
                throw new Exception("NOTSENT: StartDocPrinter failed");
            }
            if (!StartPagePrinter(hPrinter)) {
                EndDocPrinter(hPrinter);
                throw new Exception("NOTSENT: StartPagePrinter failed");
            }
            int written;
            if (!WritePrinter(hPrinter, bytes, bytes.Length, out written) || written != bytes.Length) {
                EndPagePrinter(hPrinter);
                EndDocPrinter(hPrinter);
                throw new Exception("WritePrinter failed");
            }
            if (!EndPagePrinter(hPrinter)) {
                throw new Exception("EndPagePrinter failed");
            }
            if (!EndDocPrinter(hPrinter)) {
                throw new Exception("EndDocPrinter failed");
            }
        } finally {
            ClosePrinter(hPrinter);
        }
    }
}
"@

$bytes = [System.IO.File]::ReadAllBytes($env:FORKFLOW_PRINT_PAYLOAD)
$printerName = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:FORKFLOW_PRINT_NAME))
try {
    [RawPrinterHelper]::SendBytesToPrinter($printerName, $bytes)
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    if ($_.Exception.Message -like 'NOTSENT:*') { exit ${EXIT_NOT_SENT} } else { exit ${EXIT_MAYBE_SENT} }
}
`;

  await fs.writeFile(scriptPath, psScript, "utf8");

  await new Promise<void>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { timeout: 15000, windowsHide: true, env: { ...process.env,
        FORKFLOW_PRINT_PAYLOAD: bytesPath, FORKFLOW_PRINT_NAME: Buffer.from(printerName, "utf8").toString("base64") } },
      (err, stdout, stderr) => {
        if (err) {
          reject(windowsFailure(err, stderr));
        } else {
          resolve();
        }
      }
    );
  });
  } finally {
    // Cleanup cannot turn an accepted submission into an apparent print failure.
    await fs.rm(directory, { recursive: true, force: true }).catch(error => console.error("Print temporary-file cleanup failed", error));
  }
}

async function sendToBluetooth(connection: string, bytes: Buffer): Promise<void> {
  if (!/^COM[1-9]\d{0,3}$/i.test(connection)) throw new Error("Use a Bluetooth COM port such as COM3");
  const portPath = `\\\\.\\${connection}`;
  try {
    await fs.writeFile(portPath, bytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    // Failing to open the port (missing, in use, access denied) means nothing was written.
    if ((err as NodeJS.ErrnoException | undefined)?.syscall === "open") throw new Error(`Bluetooth printer could not be opened: ${message}`);
    throw new PrintOutcomeUnknown(`Bluetooth printer submission was not confirmed: ${message}`);
  }
}

/**
 * Fake sink for testing. Captures sent bytes and can be configured to fail.
 */
export function makeFakeSink(): {
  send: SinkSend;
  sent: Array<{ target: PrinterTarget; bytes: Buffer }>;
  failNext: (msg: string) => void;
} {
  const sent: Array<{ target: PrinterTarget; bytes: Buffer }> = [];
  let nextError: string | null = null;

  const send: SinkSend = async (target, bytes) => {
    if (nextError) {
      const err = nextError;
      nextError = null;
      throw new Error(err);
    }
    sent.push({ target, bytes });
  };

  const failNext = (msg: string) => {
    nextError = msg;
  };

  return { send, sent, failNext };
}
