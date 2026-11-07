import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { migrate } from "./migrate.js";
import { MIGRATIONS } from "./migrations/index.js";
import {
  financialYear, formatCreditNoteNo, formatInvoiceNo, INVOICE_COUNTER_MAX, InvoicePrefix,
  invoiceFileName, invoiceSeries, nextCreditNoteNo, nextInvoiceNo,
} from "./invoice-numbers.js";

describe("formatInvoiceNo", () => {
  it("pads to 4 digits and grows", () => {
    expect(formatInvoiceNo("MP", "25-26", 1)).toBe("MP/25-26/0001");
    expect(formatInvoiceNo("", "25-26", 1)).toBe("25-26/0001");
    expect(formatInvoiceNo("MP", "25-26", 12345)).toBe("MP/25-26/12345");
  });
  it("stays within 16 characters at the limit and throws above it", () => {
    expect(INVOICE_COUNTER_MAX).toBe(99_999);
    expect(formatInvoiceNo("ABCD", "25-26", 99_999)).toHaveLength(16);
    expect(() => formatInvoiceNo("MP", "25-26", 100_000)).toThrow(/99,?999/);
  });
});

describe("formatCreditNoteNo", () => {
  it("pads to 3 digits, grows, and throws above the limit", () => {
    expect(formatCreditNoteNo("25-26", 1)).toBe("CN/25-26/001");
    expect(formatCreditNoteNo("25-26", 1234)).toBe("CN/25-26/1234");
    expect(() => formatCreditNoteNo("25-26", 100_000)).toThrow();
  });
});

describe("financialYear", () => {
  it("starts a new year on 1 April local time", () => {
    expect(financialYear(new Date(2026, 2, 31, 23, 59, 59, 999).getTime())).toEqual({ key: "2025-26", short: "25-26" });
    expect(financialYear(new Date(2026, 3, 1, 0, 0).getTime())).toEqual({ key: "2026-27", short: "26-27" });
    expect(financialYear(new Date(2026, 0, 15).getTime())).toEqual({ key: "2025-26", short: "25-26" });
  });
  it("handles the century rollover", () => {
    expect(financialYear(new Date(2099, 11, 1).getTime())).toEqual({ key: "2099-00", short: "99-00" });
  });
});

describe("nextInvoiceNo / nextCreditNoteNo", () => {
  it("counts per financial year, survives prefix changes, and keeps credit notes separate", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    const mar = new Date(2026, 2, 31, 12).getTime();
    const apr = new Date(2026, 3, 1, 12).getTime();
    expect(nextInvoiceNo(db, "MP", mar)).toBe("MP/25-26/0001");
    expect(nextInvoiceNo(db, "MP", mar)).toBe("MP/25-26/0002");
    expect(nextInvoiceNo(db, "MP", apr)).toBe("MP/26-27/0001");
    expect(nextInvoiceNo(db, "X1", apr)).toBe("X1/26-27/0002");
    expect(nextCreditNoteNo(db, apr)).toBe("CN/26-27/001");
    expect(nextCreditNoteNo(db, apr)).toBe("CN/26-27/002");
    expect(nextInvoiceNo(db, "", apr)).toBe("26-27/0003");
    db.close();
  });
});

describe("invoiceSeries / invoiceFileName", () => {
  it("splits at the last slash", () => {
    expect(invoiceSeries("MP/25-26/0007")).toEqual({ series: "MP/25-26", n: 7 });
    expect(invoiceSeries("12")).toEqual({ series: "", n: 12 });
  });
  it("makes a file-safe name", () => {
    expect(invoiceFileName("MP/25-26/0001")).toBe("Bill-MP-25-26-0001.html");
  });
});

describe("InvoicePrefix", () => {
  it("trims, upper-cases and validates", () => {
    expect(InvoicePrefix.parse(" mp ")).toBe("MP");
    expect(InvoicePrefix.parse("")).toBe("");
    expect(InvoicePrefix.safeParse("cn").success).toBe(false);
    expect(InvoicePrefix.safeParse("ABCDE").success).toBe(false);
    expect(InvoicePrefix.safeParse("M-1").success).toBe(false);
  });
});
