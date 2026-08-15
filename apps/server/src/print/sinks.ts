import net from "node:net";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const [host, portStr] = connection.split(":");
  const port = portStr ? parseInt(portStr, 10) : 9100;

  if (!host) throw new Error("Invalid network connection string");
  if (isNaN(port)) throw new Error("Invalid port number");

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      socket.destroy();
      reject(new Error(`Network printer timeout: ${connection}`));
    }, 5000);

    socket.on("error", (err) => {
      clearTimeout(timeout);
      if (!timedOut) reject(new Error(`Network printer error: ${err.message}`));
    });

    socket.connect(port, host, () => {
      socket.write(bytes, (err) => {
        if (err) {
          clearTimeout(timeout);
          socket.destroy();
          reject(new Error(`Write failed: ${err.message}`));
        } else {
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
  // Write bytes to temp file
  const bytesPath = join(tmpdir(), `print-${Date.now()}.bin`);
  await fs.writeFile(bytesPath, bytes);

  // Embedded PowerShell script with RawPrinterHelper
  const psScript = `
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
            throw new Exception("Failed to open printer: " + printerName);
        }
        try {
            DOCINFO di = new DOCINFO();
            di.pDocName = "ForkFlow Print Job";
            di.pDataType = "RAW";
            if (StartDocPrinter(hPrinter, 1, ref di) == 0) {
                throw new Exception("StartDocPrinter failed");
            }
            if (!StartPagePrinter(hPrinter)) {
                EndDocPrinter(hPrinter);
                throw new Exception("StartPagePrinter failed");
            }
            int written;
            if (!WritePrinter(hPrinter, bytes, bytes.Length, out written)) {
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

$bytes = [System.IO.File]::ReadAllBytes("${bytesPath}")
[RawPrinterHelper]::SendBytesToPrinter("${printerName}", $bytes)
`;

  // Note: Printer names containing " or $ are unsupported in v1 (no escaping)
  const scriptPath = join(tmpdir(), `print-script-${Date.now()}.ps1`);
  await fs.writeFile(scriptPath, psScript, "utf8");

  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { timeout: 15000 },
      (err, stdout, stderr) => {
        // Cleanup temp files
        fs.unlink(bytesPath).catch(() => {});
        fs.unlink(scriptPath).catch(() => {});

        if (err) {
          reject(new Error(`Windows printer failed: ${stderr || err.message}`));
        } else {
          resolve();
        }
      }
    );
  });
}

async function sendToBluetooth(connection: string, bytes: Buffer): Promise<void> {
  const portPath = `\\\\.\\${connection}`;
  try {
    await fs.writeFile(portPath, bytes);
  } catch (err) {
    throw new Error(`Bluetooth printer error: ${err instanceof Error ? err.message : "unknown error"}`);
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
