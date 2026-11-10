/**
 * Which devices are connected: the open sockets of each one. `onChange` runs when a device's first socket opens (true)
 * and when its last one closes (false). A device on the sign-in screen has no socket, so it is offline.
 */
export class DevicePresence {
  private sockets = new Map<string, number>();
  constructor(private onChange: (deviceId: string, online: boolean) => void) {}

  open(deviceId: string): void {
    const count = this.sockets.get(deviceId) ?? 0;
    this.sockets.set(deviceId, count + 1);
    if (count === 0) this.onChange(deviceId, true);
  }
  /** Closing for a device with no open socket does nothing. */
  close(deviceId: string): void {
    const count = this.sockets.get(deviceId);
    if (count === undefined) return;
    if (count > 1) { this.sockets.set(deviceId, count - 1); return; }
    this.sockets.delete(deviceId);
    this.onChange(deviceId, false);
  }
  online(deviceId: string): boolean {
    return this.sockets.has(deviceId);
  }
}
