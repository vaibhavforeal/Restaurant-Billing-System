/** Embedded so the desktop bundle does not need a separate C# asset. */
export const serialTransportSource = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

[StructLayout(LayoutKind.Sequential)]
public struct SerialDcb {
    public uint Length, BaudRate, Flags;
    public ushort Reserved, XonLimit, XoffLimit;
    public byte ByteSize, Parity, StopBits, XonChar, XoffChar, ErrorChar, EofChar, EvtChar;
    public ushort Reserved1;
}

[StructLayout(LayoutKind.Sequential)]
public struct SerialTimeouts {
    public uint ReadInterval, ReadMultiplier, ReadConstant, WriteMultiplier, WriteConstant;
}

[StructLayout(LayoutKind.Sequential)]
public struct SerialStats {
    public uint Flags, InputQueue, OutputQueue;
}

public interface ISerialApi {
    SafeFileHandle Open(string path, uint access, uint share, uint disposition);
    bool GetState(SafeFileHandle handle, ref SerialDcb state);
    bool SetTimeouts(SafeFileHandle handle, ref SerialTimeouts timeouts);
    bool Write(SafeFileHandle handle, byte[] bytes, out uint written);
    bool OutputQueue(SafeFileHandle handle, out uint count);
    long Milliseconds { get; }
    void Pause(int milliseconds);
}

public static class SerialTransport {
    public const uint ReadWrite = 0xC0000000;
    public const uint OpenExisting = 3;

    public static void Send(ISerialApi api, string port, byte[] payload, int deadlineMs) {
        bool writeAttempted = false;
        SafeFileHandle handle = null;
        try {
            if (api == null || payload == null || payload.Length == 0 || deadlineMs <= 0)
                throw new Exception("Invalid serial payload or deadline");
            if (!System.Text.RegularExpressions.Regex.IsMatch(port ?? "", @"^COM[1-9][0-9]{0,3}$", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                throw new Exception("Use a Bluetooth COM port such as COM3");
            long start = api.Milliseconds;
            handle = api.Open(@"\\.\" + port.ToUpperInvariant(), ReadWrite, 0, OpenExisting);
            if (handle == null || handle.IsInvalid) throw new Exception("Could not open outgoing COM port");
            var state = new SerialDcb();
            state.Length = (uint)Marshal.SizeOf(typeof(SerialDcb));
            if (!api.GetState(handle, ref state)) throw new Exception("Could not read COM port configuration");
            if ((state.Flags & 1) == 0 || state.ByteSize != 8)
                throw new Exception("COM port must use binary, eight-bit mode; configure the paired outgoing port for this printer");
            int offset = 0;
            while (offset < payload.Length) {
                long remainingMs = deadlineMs - (api.Milliseconds - start);
                if (remainingMs <= 0) throw new Exception("COM send deadline expired");
                var timeouts = new SerialTimeouts();
                timeouts.WriteConstant = (uint)Math.Min(1000L, remainingMs);
                if (!api.SetTimeouts(handle, ref timeouts)) throw new Exception("Could not set COM write timeout");
                if (api.Milliseconds - start >= deadlineMs) throw new Exception("COM send deadline expired");
                int length = Math.Min(payload.Length - offset, 4096);
                var chunk = new byte[length];
                Buffer.BlockCopy(payload, offset, chunk, 0, length);
                uint accepted;
                writeAttempted = true;
                if (!api.Write(handle, chunk, out accepted)) throw new Exception("COM write failed");
                if (api.Milliseconds - start >= deadlineMs) throw new Exception("COM send deadline expired");
                if (accepted == 0 || accepted > length) throw new Exception("COM write made no valid progress");
                offset += (int)accepted;
            }
            while (true) {
                if (api.Milliseconds - start >= deadlineMs) throw new Exception("COM output did not drain before deadline");
                uint remaining;
                if (!api.OutputQueue(handle, out remaining)) throw new Exception("Could not inspect COM output queue");
                if (api.Milliseconds - start >= deadlineMs) throw new Exception("COM output did not drain before deadline");
                if (remaining == 0) return;
                api.Pause(20);
            }
        } catch (Exception error) {
            throw new Exception((writeAttempted ? "MAYBESENT: " : "NOTSENT: ") + error.Message);
        } finally {
            if (handle != null) handle.Dispose();
        }
    }
}

public sealed class Win32SerialApi : ISerialApi {
    [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", EntryPoint="GetCommState", SetLastError=true)]
    private static extern bool NativeGetState(SafeFileHandle handle, ref SerialDcb state);
    [DllImport("kernel32.dll", EntryPoint="SetCommTimeouts", SetLastError=true)]
    private static extern bool NativeSetTimeouts(SafeFileHandle handle, ref SerialTimeouts timeouts);
    [DllImport("kernel32.dll", EntryPoint="WriteFile", SetLastError=true)]
    private static extern bool NativeWrite(SafeFileHandle handle, byte[] bytes, uint count, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", EntryPoint="ClearCommError", SetLastError=true)]
    private static extern bool ClearCommError(SafeFileHandle handle, out uint errors, out SerialStats stats);

    public SafeFileHandle Open(string path, uint access, uint share, uint disposition) {
        return CreateFile(path, access, share, IntPtr.Zero, disposition, 0, IntPtr.Zero);
    }
    public bool GetState(SafeFileHandle handle, ref SerialDcb state) { return NativeGetState(handle, ref state); }
    public bool SetTimeouts(SafeFileHandle handle, ref SerialTimeouts timeouts) { return NativeSetTimeouts(handle, ref timeouts); }
    public bool Write(SafeFileHandle handle, byte[] bytes, out uint written) { return NativeWrite(handle, bytes, (uint)bytes.Length, out written, IntPtr.Zero); }
    public bool OutputQueue(SafeFileHandle handle, out uint count) {
        uint errors;
        SerialStats stats;
        bool ok = ClearCommError(handle, out errors, out stats);
        count = ok ? stats.OutputQueue : 0;
        return ok && errors == 0;
    }
    public long Milliseconds { get { return Stopwatch.GetTimestamp() * 1000L / Stopwatch.Frequency; } }
    public void Pause(int milliseconds) { Thread.Sleep(milliseconds); }
}
`;

export const serialPowerShell = `
$ErrorActionPreference = 'Stop'
try {
    Add-Type -TypeDefinition @"
${serialTransportSource}
"@
    $bytes = [System.IO.File]::ReadAllBytes($env:FORKFLOW_PRINT_PAYLOAD)
    $port = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:FORKFLOW_PRINT_NAME))
} catch {
    [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
    exit 20
}
try {
    [SerialTransport]::Send([Win32SerialApi]::new(), $port, $bytes, 10000)
} catch {
    $message = $_.Exception.GetBaseException().Message
    [Console]::Error.WriteLine($message)
    if ($message -like 'NOTSENT:*') { exit 20 } else { exit 21 }
}
`;
