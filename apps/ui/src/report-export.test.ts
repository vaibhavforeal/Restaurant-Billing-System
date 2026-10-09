import { describe, expect, it } from "vitest";
import { dayEndCsv, netTaxes, type DayEndReport } from "./report-export";

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
    creditNotes: { count: 1, taxablePaise: 1000, cgstPaise: 25, sgstPaise: 25, totalPaise: 1050,
      taxes: [{ gstRate: 5, taxablePaise: 1000, cgstPaise: 25, sgstPaise: 25 }] },
    refunds: [{ mode: "cash", amountPaise: 1050 }],
    net: { totalPaise: 19350, taxablePaise: 18000, cgstPaise: 700, sgstPaise: 700 },
    netPayments: [{ mode: "cash", amountPaise: 8950 }, { mode: "upi", amountPaise: 5555 }], zomatoReceivablePaise: 0,
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
    expect(rows).toHaveLength(45);
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

  it("exports credit notes, refunds, net sales, net GST per rate and net payments", () => {
    const result = dayEndCsv(report());
    expect(result).toContain('"Credit notes (voids and refunds)","Credit notes issued","","1","count"');
    expect(result).toContain('"Credit notes (voids and refunds)","Credit note total","","10.50","INR"');
    expect(result).toContain('"Credit notes (voids and refunds)","Taxable","","10.00","INR"');
    expect(result).toContain('"Credit notes GST breakdown","Taxable","5","10.00","INR"');
    expect(result).toContain('"Refunds paid on this date","CASH","","10.50","INR"');
    expect(result).toContain('"Refunds paid on this date","UPI","","0.00","INR"');
    expect(result).toContain('"Refunds paid on this date","Total refunded","","10.50","INR"');
    expect(result).toContain('"Net sales (after credit notes)","Net sales including GST and rounding","","193.50","INR"');
    expect(result).toContain('"Net GST breakdown","Taxable","5","90.00","INR"');
    expect(result).toContain('"Net GST breakdown","CGST","5","2.25","INR"');
    expect(result).toContain('"Net GST breakdown","Taxable","12","90.00","INR"');
    expect(result).toContain('"Net payments received (after refunds)","CASH","","89.50","INR"');
    expect(result).toContain('"Net payments received (after refunds)","Total received","","145.05","INR"');
  });

  it("computes net GST per rate as gross minus credit notes, including rates only credited", () => {
    expect(netTaxes(report().taxes, report().creditNotes.taxes)).toEqual([
      { gstRate: 5, taxablePaise: 9000, cgstPaise: 225, sgstPaise: 225 },
      { gstRate: 12, taxablePaise: 9000, cgstPaise: 540, sgstPaise: 540 },
    ]);
    expect(netTaxes([], [{ gstRate: 18, taxablePaise: 100, cgstPaise: 9, sgstPaise: 9 }])).toEqual([{ gstRate: 18, taxablePaise: -100, cgstPaise: -9, sgstPaise: -9 }]);
  });

  it("exports an empty business date with explicit zero totals and all payment modes", () => {
    const empty = report();
    empty.sales = { billCount: 0, subtotalPaise: 0, discountPaise: 0, cgstPaise: 0, sgstPaise: 0, roundingPaise: 0, totalPaise: 0, outstandingPaise: 0 };
    empty.taxes = []; empty.payments = []; empty.cancellations.orderCount = 0;
    empty.creditNotes = { count: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, totalPaise: 0, taxes: [] };
    empty.refunds = []; empty.netPayments = []; empty.net = { totalPaise: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0 };
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
