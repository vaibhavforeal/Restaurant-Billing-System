import { describe, expect, it } from "vitest";
import { gstPeriod, gstReturnsReport } from "@masalapos/domain/gst-returns";
import { defaultGstMonth, gstReturnsCsvName, gstr1JsonName, gstAuditorCsv, gstAuditorEmail } from "./gst-returns";

describe("GST returns screen helpers", () => {
  it("opens on last month, across a year end", () => {
    expect(defaultGstMonth("2026-11-05")).toBe("2026-10");
    expect(defaultGstMonth("2027-01-10")).toBe("2026-12");
  });
  it("names the downloads by period", () => {
    expect(gstReturnsCsvName({ from: "2026-10-01", to: "2026-12-31" })).toBe("masalapos-gst-returns-2026-10-01-to-2026-12-31.csv");
    expect(gstr1JsonName("29AAPFU0939F1ZR", "102026")).toBe("GSTR1_29AAPFU0939F1ZR_102026.json");
  });
  it("includes the full quarter, GST identity, and report warnings for the auditor", () => {
    const report = gstReturnsReport({ regime: "regular", period: gstPeriod("2026-11", "quarter"), gstin: "29AAPFU0939F1ZR",
      stateCode: "29", sacCode: "996331", ecoGstin: "", bills: [], creditNotes: [], today: "2027-01-05", timezone: "Asia/Kolkata", generatedAt: Date.UTC(2027, 0, 5) });
    report.warnings = ["Review credit notes before filing."];
    const csv = gstAuditorCsv(report);
    expect(csv.name).toContain("2026-10-01-to-2026-12-31");
    expect(csv.content).toContain("GSTIN: 29AAPFU0939F1ZR");
    expect(csv.content).toContain("Warning: Review credit notes before filing.");
    const email = gstAuditorEmail(report, [csv]);
    expect(email.body).toContain("2026-10-01 to 2026-12-31");
    expect(email.body).toContain(csv.name);
    expect(email.body).toContain("Review credit notes before filing.");
    expect(email.subject).toContain(report.period.label);
  });
});
