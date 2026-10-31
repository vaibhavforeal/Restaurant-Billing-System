import { z } from "zod";

export const CloudBackupPreferences = z.object({
  automatic: z.boolean().default(true),
  folderName: z.string().trim().min(1).max(100).regex(/^[^\\/\x00-\x1f]+$/, "Use a folder name without slashes").default("MasalaPOS Backups"),
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
  /** A browser sign-in started on the main PC is waiting for Google. */
  connecting: boolean;
  /** Sign-in and restore run only on the main POS PC, where the browser callback and desktop app live. */
  onMainPc: boolean;
}

/** A MasalaPOS backup stored in the connected Google Drive. */
export interface CloudBackupFile {
  id: string;
  name: string;
  kind: "daily" | "manual" | "pre-update";
  createdAt: number;
  bytes: number;
  restaurantName: string | null;
  /** Uploaded by this POS installation (others are e.g. an old PC's backups). */
  thisPc: boolean;
}

/** What a checked backup contains, shown before anything is restored. */
export interface RestorePreview {
  token: string;
  source: "file" | "local" | "drive";
  label: string;
  bytes: number;
  /** When the snapshot was taken, if its file name records it. */
  takenAt: number | null;
  restaurantName: string;
  orders: number;
  bills: number;
  lastBillAt: number | null;
  lastOrderAt: number | null;
}
