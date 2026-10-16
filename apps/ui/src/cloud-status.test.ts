import { expect, it } from "vitest";
import { cloudBackupLabel, cloudConnectionLabel } from "./cloud-status-model";
it("keeps outlet reachability separate from internet and cloud availability", () => {
  expect(cloudConnectionLabel(null, true)).toMatchObject({ title: "Outlet computer unreachable", severity: "error" });
  expect(cloudConnectionLabel({ state: "offline", pendingUploads: 12 }, false)).toMatchObject({ title: "Cloud connection unavailable", severity: "warning" });
  expect(cloudConnectionLabel({ state: "connected", pendingUploads: 12 }, false).detail).toContain("12");
  expect(cloudConnectionLabel({ state: "not_paired", pendingUploads: 0 }, false).title).toBe("Cloud is not paired");
});
it("reports backup age independently of pending upload and last failure", () => {
  expect(cloudBackupLabel(null, 100000).title).toBe("Backup status unavailable");
  expect(cloudBackupLabel({ lastBackupAt: null, pendingBackup: false, uploading: false, lastError: null }, 100000)).toMatchObject({ title: "No cloud backup uploaded", age: "Not yet uploaded" });
  expect(cloudBackupLabel({ lastBackupAt: 1000, pendingBackup: true, uploading: false, lastError: null }, 181000)).toMatchObject({ title: "Backup waiting to upload", age: "3 minutes ago" });
  expect(cloudBackupLabel({ lastBackupAt: 1000, pendingBackup: true, uploading: true, lastError: null }, 181000).title).toBe("Backup upload in progress");
  expect(cloudBackupLabel({ lastBackupAt: 1000, pendingBackup: true, uploading: false, lastError: "Upload failed" }, 181000)).toMatchObject({ title: "Cloud backup needs attention", age: "3 minutes ago", severity: "warning" });
});
