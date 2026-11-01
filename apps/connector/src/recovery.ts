import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
const powershell = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
/** Separate elevated guardian survives Electron failure. Its boot task is restore-only. */
export class PromptRecovery {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly here: string, private readonly lost: () => void) {}
  async enable(): Promise<void> {
    if (this.child) return;
    const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(process.env["ProgramData"] ?? "C:\\ProgramData", "MasalaPOS/SupportConnector/recovery/recovery.ps1"), "-Action", "Watch", "-ParentId", String(process.pid)], { windowsHide: true, stdio: "pipe" });
    this.child = child;
    child.stdin.on("error", () => {});
    child.on("exit", () => { if (this.child === child) { this.child = null; if (this.heartbeat) clearInterval(this.heartbeat); if (this.ready) this.lost(); this.ready = false; } });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Recovery setup timed out; admin prompt access is unavailable")), 25_000);
        let output = "";
        child.stdout.on("data", (data: Buffer) => { output += data.toString(); if (output.includes("READY")) { clearTimeout(timeout); this.ready = true; resolve(); } });
        child.once("error", () => { clearTimeout(timeout); reject(new Error("Could not start Windows recovery")); });
        child.once("exit", () => { clearTimeout(timeout); reject(new Error("Windows recovery could not be prepared. Continue with admin prompt access unchecked.")); });
      });
      this.heartbeat = setInterval(() => child.stdin.write("PING\n"), 1000);
    } catch (error) { await this.restore(); throw error; }
  }
  async restore(): Promise<void> {
    const child = this.child;
    this.child = null; this.ready = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (child && child.exitCode === null) await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 15_000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
      child.stdin.end("STOP\n");
    });
    if (existsSync(join(process.env["ProgramData"] ?? "C:\\ProgramData", "MasalaPOS/SupportConnector/recovery/restore.json"))) {
      throw new Error("Screen sharing stopped, but Windows could not confirm restoration of the admin-prompt setting. Restart Windows to retry the saved recovery task. Contact your local administrator if this message returns.");
    }
  }
}
