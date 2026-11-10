import { BackupSettings } from "./BackupSettings";

/** Settings → Backups. Connecting devices is under Settings → Devices → Add device. */
export function SystemSettings() {
  return <section aria-label="Backups" className="system-settings"><BackupSettings /></section>;
}
