export interface CloudStatus {
  state: "not_paired" | "connected" | "offline" | "error";
  outletId: string | null;
  lastContact: number | null;
  acknowledgedSequence: number;
  pendingUploads: number;
  initialSyncComplete: boolean;
  lastError: string | null;
  serviceVersion: string;
}
export interface CloudBackupStatus { lastBackupAt: number | null; pendingBackup: boolean; lastError: string | null; uploading: boolean }
export function cloudBackupLabel(status: CloudBackupStatus | null, now = Date.now()): { title: string; age: string; severity: "neutral" | "warning" | "success" } {
  if (!status) return { title: "Backup status unavailable", age: "Unknown", severity: "neutral" };
  const elapsed = status.lastBackupAt === null ? null : Math.max(0, now - status.lastBackupAt), minutes = Math.floor((elapsed ?? 0) / 60000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  const age = elapsed === null ? "Not yet uploaded" : days ? `${days} day${days === 1 ? "" : "s"} ago` : hours ? `${hours} hour${hours === 1 ? "" : "s"} ago` : minutes ? `${minutes} minute${minutes === 1 ? "" : "s"} ago` : "Less than a minute ago";
  if (status.uploading) return { title: "Backup upload in progress", age, severity: "neutral" };
  if (status.lastError) return { title: "Cloud backup needs attention", age, severity: "warning" };
  if (status.pendingBackup) return { title: "Backup waiting to upload", age, severity: "neutral" };
  if (status.lastBackupAt === null) return { title: "No cloud backup uploaded", age, severity: "neutral" };
  return { title: "Cloud backup uploaded", age, severity: "success" };
}
export function cloudConnectionLabel(status: Pick<CloudStatus, "state" | "pendingUploads"> | null, unreachable: boolean): { title: string; detail: string; severity: "error" | "warning" | "success" | "neutral" } {
  if (unreachable) return { title: "Outlet computer unreachable", detail: "Reconnect to the restaurant network. New operations need the outlet computer; cloud connectivity is a separate connection.", severity: "error" };
  if (!status) return { title: "Checking cloud connection", detail: "Reading the connection status from this outlet.", severity: "neutral" };
  if (status.state === "not_paired") return { title: "Cloud is not paired", detail: "Pair this outlet with the owner portal to upload reports and receive owner changes.", severity: "neutral" };
  if (status.state === "connected") return { title: "Outlet connected to cloud", detail: status.pendingUploads ? `${status.pendingUploads} changes are waiting to upload. Local billing continues normally.` : "No changes are waiting to upload. Local billing runs on this outlet computer.", severity: "success" };
  return { title: "Cloud connection unavailable", detail: "The outlet is reachable. Local billing continues; uploads resume when the internet and cloud connection recover.", severity: "warning" };
}
