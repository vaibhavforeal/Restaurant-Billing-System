import { describe, expect, it } from "vitest";
import { dayEndCsv, type DayEndReport } from "./report-export";

function report(): DayEndReport {
  return {
    date: "2026-09-29", timezone: "Asia/Calcutta",
    sales: { billCount: 2, subtotalPaise: 20000, discountPaise: 1000, cgstPaise: 725, sgstPaise: 725,
      roundingPaise: -50, totalPaise: 20400, outstandingPaise: 5400 },
    taxes: [
      { gstRate: 5, taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250 },
      { gstRate: 12, taxablePaise: 9000, cgstPaise: 540, sgstPaise: 540 },
    ],
    payments: [{ mode: "cash", amountPaise: 10000 }, { mode: "upi", amountPaise: 5555 }],
    cancellations: { orderCount: 3 },
  };
}

describe("day-end CSV export", () => {
  it("exports all report sections in rupees with numeric negative rounding and distinct collections", () => {
    const result = dayEndCsv(report());
    expect(result.startsWith('\uFEFF"Business date","Server timezone"')).toBe(true);
    expect(result.endsWith("\r\n")).toBe(true);
    const prefix = '"2026-09-29","Asia/Calcutta",';
    const rows = result.split("\r\n").slice(1, -1);
    expect(rows.every((row) => row.startsWith(prefix))).toBe(true);
    expect(rows).toHaveLength(19);
    expect(result).toContain('"Number of bills","","2","count"');
    expect(result).toContain('"Subtotal before discount","","200.00","INR"');
    expect(result).toContain('"Discounts","","10.00","INR"');
    expect(result).toContain('"Round off","","-0.50","INR"');
    expect(result).toContain('"Sales including GST and rounding","","204.00","INR"');
    expect(result).toContain('"Still unpaid (current)","","54.00","INR"');
    expect(result).toContain('"Orders cancelled on this date","","3","count"');
    expect(result).toContain('"GST breakdown","Taxable","5","100.00","INR"');
    expect(result).toContain('"GST breakdown","CGST","12","5.40","INR"');
    expect(result).toContain('"GST breakdown","SGST","12","5.40","INR"');
    expect(result).toContain('"Payments received on this date (includes older bills)","UPI","","55.55","INR"');
    expect(result).toContain('"CARD","","0.00","INR"');
    expect(result).toContain('"Total received","","155.55","INR"');
  });

  it("exports an empty business date with explicit zero totals and all payment modes", () => {
    const empty = report();
    empty.sales = { billCount: 0, subtotalPaise: 0, discountPaise: 0, cgstPaise: 0, sgstPaise: 0, roundingPaise: 0, totalPaise: 0, outstandingPaise: 0 };
    empty.taxes = []; empty.payments = []; empty.cancellations.orderCount = 0;
    const result = dayEndCsv(empty);
    expect(result).toContain('"Number of bills","","0","count"');
    expect(result).toContain('"Sales including GST and rounding","","0.00","INR"');
    for (const mode of ["CASH", "UPI", "CARD", "Total received"]) expect(result).toContain(`"${mode}","","0.00","INR"`);
    expect(result).not.toMatch(/undefined|NaN|null/);
  });

  it("quotes CSV text and protects text formulas without turning signed amounts into text", () => {
    const data = report(); data.timezone = '=Test,"zone"\nnext';
    const result = dayEndCsv(data);
    expect(result).toContain('"\'=Test,""zone""\nnext"');
    expect(result).toContain('"-0.50"');
    expect(result).not.toContain("'-0.50");
  });
});
