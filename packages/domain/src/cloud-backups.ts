import { z } from "zod";

export const CloudBackupPreferences = z.object({
  automatic: z.boolean().default(true),
  folderName: z.string().trim().min(1).max(100).regex(/^[^\\/\x00-\x1f]+$/, "Use a folder name without slashes").default("ForkFlow Backups"),
  retentionDays: z.number().int().min(7).max(365).default(30),
}).strict();

export type CloudBackupSettings = z.infer<typeof CloudBackupPreferences>;
export type CloudBackupState = "not_configured" | "not_connected" | "connected" | "reconnect_required";
export interface CloudBackupAccount { id: string; email: string }
export interface CloudBackupStatus extends CloudBackupSettings {
  provider: "google_drive";
  state: CloudBackupState;
  account: CloudBackupAccount | null;
  uploading: boolean;
  pendingCount: number;
  lastUploadedAt: number | null;
  lastUploadedName: string | null;
  lastError: string | null;
  queue: Array<{ name: string; attempts: number; nextAttemptAt: number }>;
}
