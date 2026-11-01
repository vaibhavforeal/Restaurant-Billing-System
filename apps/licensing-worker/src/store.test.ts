import { beforeEach, describe, expect, it } from "vitest";
import type { D1Like } from "./env.js";
import { createInstallation, getInstallation, insertLicenseStatement, latestLicense, nextRevision, recordEventStatement, type LicenseRow } from "./store.js";
import { memoryD1 } from "./testing/d1.js";

const install = (id: string, revisionFloor = 0) => ({ installationId: id, licenseId: `lic-${id}`, organizationId: "org", outletId: "out", revisionFloor, createdAt: 1, secretHash: null });
const licence = (installationId: string, revision: number, over: Partial<LicenseRow> = {}): LicenseRow => ({
  installationId, revision, plan: "pro", issuedAt: 1, expiresAt: 2, graceUntil: 3, envelope: `env-${revision}`, reason: "order", orderId: null, ...over,
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

  it("createInstallation stores the secret hash and a retry keeps the first one", async () => {
    await createInstallation(db, { ...install("i1"), secretHash: "h1" });
    await createInstallation(db, { ...install("i1"), secretHash: "h2" });
    expect((await getInstallation(db, "i1"))!.secretHash).toBe("h1");
    await createInstallation(db, install("i2"));
    expect((await getInstallation(db, "i2"))!.secretHash).toBeNull();
  });

  it("a batch that fails writes nothing", async () => {
    await createInstallation(db, install("i1"));
    await db.batch([recordEventStatement(db, "evt1", "x", "issued", 1)]);
    await expect(db.batch([insertLicenseStatement(db, licence("i1", 1)), recordEventStatement(db, "evt1", "x", "issued", 2)])).rejects.toThrow();
    expect(await latestLicense(db, "i1")).toBeNull();
  });

  it("a licence's reason and plan are checked", async () => {
    await createInstallation(db, install("i1"));
    await expect(db.batch([insertLicenseStatement(db, licence("i1", 1, { reason: "charge" as never }))])).rejects.toThrow();
    await expect(db.batch([insertLicenseStatement(db, licence("i1", 1, { plan: "gold" as never }))])).rejects.toThrow();
  });
});
