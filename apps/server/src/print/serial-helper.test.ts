import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serialPowerShell, serialTransportSource } from "./serial-helper.js";

const fakeSource = String.raw`
public sealed class FakeSerialApi : ISerialApi {
    public SafeFileHandle Handle = new SafeFileHandle(new IntPtr(123), false);
    public string Path;
    public uint Access, Share, Disposition;
    public SerialDcb State = new SerialDcb { BaudRate = 115200, Flags = 0x11, ByteSize = 8 };
    public uint RequestedDcbSize;
    public SerialTimeouts Timeouts;
    public bool OpenFails, StateFails, TimeoutFails, WriteFails, QueueFails, NeverDrain, AdvanceAfterWrite, AdvanceWriteByTimeout;
    public int FailTimeoutCall, TimeoutCalls, AdvanceFirstWriteBy, AdvanceQueueBy;
    public List<uint> WriteTimeouts = new List<uint>();
    public uint[] Progress = new uint[0];
    public int Calls;
    public long Clock;
    public List<byte> Accepted = new List<byte>();
    public SafeFileHandle Open(string path, uint access, uint share, uint disposition) {
        Path = path; Access = access; Share = share; Disposition = disposition;
        if (OpenFails) return new SafeFileHandle(IntPtr.Zero, false);
        return Handle;
    }
    public bool GetState(SafeFileHandle handle, ref SerialDcb state) { RequestedDcbSize = state.Length; state = State; return !StateFails; }
    public bool SetTimeouts(SafeFileHandle handle, ref SerialTimeouts timeouts) {
        Timeouts = timeouts; WriteTimeouts.Add(timeouts.WriteConstant); TimeoutCalls++;
        return !TimeoutFails && TimeoutCalls != FailTimeoutCall;
    }
    public bool Write(SafeFileHandle handle, byte[] bytes, out uint written) {
        int call = Calls++;
        written = call < Progress.Length ? Progress[call] : (uint)bytes.Length;
        if (WriteFails) return false;
        for (int i = 0; i < written && i < bytes.Length; i++) Accepted.Add(bytes[i]);
        if (AdvanceAfterWrite) Clock += 10000;
        if (AdvanceWriteByTimeout) Clock += Timeouts.WriteConstant;
        if (call == 0) Clock += AdvanceFirstWriteBy;
        return true;
    }
    public bool OutputQueue(SafeFileHandle handle, out uint count) {
        Clock += AdvanceQueueBy;
        count = NeverDrain ? 1U : 0U;
        return !QueueFails;
    }
    public long Milliseconds { get { return Clock; } }
    public void Pause(int milliseconds) { Clock += milliseconds; }
}

public static class SerialHarness {
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static string Failure(FakeSerialApi api, byte[] bytes, int deadline) {
        try { SerialTransport.Send(api, "COM10", bytes, deadline); return "SUCCESS"; }
        catch (Exception error) { return error.Message; }
    }
    public static void Run(string scenario) {
        var api = new FakeSerialApi();
        byte[] bytes = new byte[] { 0, 0x1b, 0xff };
        string result;
        switch (scenario) {
            case "success":
                api.Progress = new uint[] { 1, 2 };
                result = Failure(api, bytes, 10000);
                Check(result == "SUCCESS", result);
                Check(api.Path == @"\\.\COM10", "wrong Win32 device path");
                Check(api.Access == 0xC0000000 && api.Share == 0 && api.Disposition == 3, "wrong exclusive open flags");
                Check(api.State.BaudRate == 115200 && api.State.Flags == 0x11, "configured DCB changed");
                Check(api.RequestedDcbSize > 0, "DCB length was not initialized");
                Check(api.Timeouts.WriteConstant == 1000, "write timeout missing");
                Check(api.Calls == 2 && api.Accepted.Count == 3 && api.Accepted[0] == 0 && api.Accepted[1] == 0x1b && api.Accepted[2] == 0xff, "partial write repeated or lost bytes");
                Check(api.Handle.IsClosed, "handle was not disposed");
                break;
            case "open":
                api.OpenFails = true;
                result = Failure(api, bytes, 10000);
                Check(result.StartsWith("NOTSENT:") && api.Calls == 0, result);
                break;
            case "config":
                api.State.ByteSize = 7;
                result = Failure(api, bytes, 10000);
                Check(result.StartsWith("NOTSENT:") && result.Contains("eight-bit") && api.Calls == 0 && api.Handle.IsClosed, result);
                break;
            case "zero":
                api.Progress = new uint[] { 0 };
                result = Failure(api, bytes, 10000);
                Check(result.StartsWith("MAYBESENT:") && api.Handle.IsClosed, result);
                break;
            case "write-error":
                api.WriteFails = true;
                result = Failure(api, bytes, 10000);
                Check(result.StartsWith("MAYBESENT:") && api.Handle.IsClosed, result);
                break;
            case "drain":
                api.NeverDrain = true;
                result = Failure(api, bytes, 60);
                Check(result.StartsWith("MAYBESENT:") && api.Clock >= 60 && api.Handle.IsClosed, result);
                break;
            case "partial-deadline":
                api.Progress = new uint[] { 1 };
                api.AdvanceAfterWrite = true;
                result = Failure(api, bytes, 10000);
                Check(result.StartsWith("MAYBESENT:") && api.Accepted.Count == 1 && api.Handle.IsClosed, result);
                break;
            case "write-budget":
                api.AdvanceWriteByTimeout = true;
                result = Failure(api, bytes, 10);
                Check(result.StartsWith("MAYBESENT:") && api.WriteTimeouts.Count == 1 && api.WriteTimeouts[0] == 10 && api.Clock == 10 && api.Handle.IsClosed, result + "; timeout=" + api.Timeouts.WriteConstant + "; clock=" + api.Clock);
                break;
            case "partial-budget":
                api.Progress = new uint[] { 1, 2 };
                api.AdvanceFirstWriteBy = 7;
                result = Failure(api, bytes, 10);
                Check(result == "SUCCESS" && api.WriteTimeouts.Count == 2 && api.WriteTimeouts[0] == 10 && api.WriteTimeouts[1] == 3 && api.Handle.IsClosed, result + "; timeout calls=" + api.WriteTimeouts.Count);
                break;
            case "slow-queue":
                api.AdvanceQueueBy = 10;
                result = Failure(api, bytes, 10);
                Check(result.StartsWith("MAYBESENT:") && api.Clock == 10 && api.Handle.IsClosed, result);
                break;
            case "timeout-config-before-write":
                api.FailTimeoutCall = 1;
                result = Failure(api, bytes, 10);
                Check(result.StartsWith("NOTSENT:") && api.Calls == 0 && api.Handle.IsClosed, result);
                break;
            case "timeout-config-after-write":
                api.Progress = new uint[] { 1, 2 };
                api.FailTimeoutCall = 2;
                result = Failure(api, bytes, 10);
                Check(result.StartsWith("MAYBESENT:") && api.Accepted.Count == 1 && api.Handle.IsClosed, result);
                break;
            case "queue-error":
                api.QueueFails = true;
                result = Failure(api, bytes, 10000);
                Check(result.StartsWith("MAYBESENT:") && api.Handle.IsClosed, result);
                break;
            case "deadline":
                api.Clock = 100;
                result = Failure(api, bytes, 0);
                Check(result.StartsWith("NOTSENT:") && api.Calls == 0, result);
                break;
            default: throw new Exception("unknown scenario");
        }
    }
}
`;

let directory: string;
let script: string;
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "forkflow-serial-test-"));
  script = join(directory, "harness.ps1");
  writeFileSync(script, `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @"\n${serialTransportSource}\n${fakeSource}\n"@\n[SerialHarness]::Run($args[0])\n`, "utf8");
});
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

describe.skipIf(process.platform !== "win32")("Win32 serial transport with a fake API", () => {
  for (const scenario of ["success", "open", "config", "zero", "write-error", "drain", "partial-deadline", "write-budget", "partial-budget", "slow-queue", "timeout-config-before-write", "timeout-config-after-write", "queue-error", "deadline"]) {
    it(scenario, () => {
      expect(() => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, scenario], { encoding: "utf8", windowsHide: true, timeout: 5000 })).not.toThrow();
    });
  }

  it("returns pre-write exit 20 if the payload cannot be read", () => {
    const wrapper = join(directory, "serial.ps1");
    writeFileSync(wrapper, serialPowerShell, "utf8");
    try {
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper], {
        encoding: "utf8", windowsHide: true, timeout: 5000,
        env: { ...process.env, FORKFLOW_PRINT_PAYLOAD: join(directory, "missing.bin"), FORKFLOW_PRINT_NAME: Buffer.from("COM9999").toString("base64") }
      });
      throw new Error("expected payload read to fail");
    } catch (error) {
      expect((error as { status?: number }).status).toBe(20);
    }
  });
});
