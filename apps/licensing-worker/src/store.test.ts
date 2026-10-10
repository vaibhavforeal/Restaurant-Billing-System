import { beforeEach, describe, expect, it } from "vitest";
import type { D1Like } from "./env.js";
import { createInstallation, getInstallation, insertLicenseStatement, latestLicense, nextRevision, recordEventStatement, type LicenseRow } from "./store.js";
import { memoryD1 } from "./testing/d1.js";

const install = (id: string, revisionFloor = 0) => ({ installationId: id, licenseId: `lic-${id}`, organizationId: "org", outletId: "out", trialStartedAt: null, revisionFloor, createdAt: 1 });
const licence = (installationId: string, revision: number, over: Partial<LicenseRow> = {}): LicenseRow => ({
  installationId, revision, plan: "pro", issuedAt: 1, expiresAt: 2, graceUntil: 3, envelope: `env-${revision}`, reason: "charge",
  razorpaySubscriptionId: null, razorpayPaymentId: null, ...over,
});

describe("licensing store", () => {
  let db: D1Like;
  beforeEach(() => { db = memoryD1(); });

  it("next revision honours the adoption floor", async () => {
    await createInstallation(db, install("i1", 3));
    expect(await nextRevision(db, "i1")).toBe(4);
    await db.batch([insertLicenseStatement(db, licence("i1", 4))]);
    expect(await nextRevision(db, "i1")).toBe(5);
    expect((await latestLicense(db, "i1"))?.revision).toBe(4);
  });

  it("createInstallation is idempotent", async () => {
    await createInstallation(db, install("i1"));
    await createInstallation(db, { ...install("i1"), licenseId: "other", organizationId: "other-org" });
    expect(await getInstallation(db, "i1")).toMatchObject({ licenseId: "lic-i1", organizationId: "org" });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM installations").first<{ n: number }>())?.n).toBe(1);
  });

  it("a batch that fails writes nothing", async () => {
    await createInstallation(db, install("i1"));
    await db.batch([recordEventStatement(db, "evt1", "x", "issued", 1)]);
    await expect(db.batch([insertLicenseStatement(db, licence("i1", 1)), recordEventStatement(db, "evt1", "x", "issued", 2)])).rejects.toThrow();
    expect(await latestLicense(db, "i1")).toBeNull();
  });

  it("payment ids are unique", async () => {
    await createInstallation(db, install("i1"));
    await db.batch([insertLicenseStatement(db, licence("i1", 1, { razorpayPaymentId: "pay_1" }))]);
    await expect(db.batch([insertLicenseStatement(db, licence("i1", 2, { razorpayPaymentId: "pay_1" }))])).rejects.toThrow();
  });
});
