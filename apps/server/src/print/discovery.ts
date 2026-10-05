import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

export interface DiscoveredPrinter { name: string; driver: string; port: string; isDefault: boolean }
export interface PrinterDiscovery { supported: boolean; printers: DiscoveredPrinter[] }
const execute = promisify(execFile);
const Row = z.object({ Name: z.string(), DriverName: z.string().nullable(), PortName: z.string().nullable(), Default: z.boolean() });

export async function discoverWindowsPrinters(): Promise<PrinterDiscovery> {
  if (process.platform !== "win32") return { supported: false, printers: [] };
  const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Printer | Select-Object Name, DriverName, PortName, Default)`;
  const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, encoding: "utf8" });
  const rows = z.array(Row).parse(JSON.parse(stdout.replace(/^\uFEFF/, "").trim()));
  return { supported: true, printers: rows.map(row => ({ name: row.Name, driver: row.DriverName ?? "", port: row.PortName ?? "", isDefault: row.Default }))
    .sort((a, b) => a.name.localeCompare(b.name)) };
}
