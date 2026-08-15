import { describe, expect, it } from "vitest";
import { kotSlip, cancelSlip } from "./templates.js";
import { renderBytes } from "./render-bytes.js";

describe("templates", () => {
  const baseDate = new Date("2026-08-15T14:30:00").getTime();

  describe("kotSlip", () => {
    it("dine-in split A 80mm (snapshot)", () => {
      const ctx = {
        kotNo: 42,
        stationName: "Kitchen",
        orderType: "dine_in" as const,
        tableName: "T1",
        splitLabel: "A",
        items: [
          { qty: 2, name: "Biryani (Half)", note: null, cancelled: false },
          { qty: 1, name: "Paneer Tikka", note: "Extra spicy", cancelled: false },
        ],
        atMs: baseDate,
      };
      const buf = kotSlip(ctx, 80);
      expect(renderBytes(buf)).toMatchSnapshot();
    });

    it("dine-in split B 58mm (snapshot, asserts T1 / B and 32-char hr)", () => {
      const ctx = {
        kotNo: 43,
        stationName: "Bar",
        orderType: "dine_in" as const,
        tableName: "T1",
        splitLabel: "B",
        items: [{ qty: 1, name: "Mojito", note: null, cancelled: false }],
        atMs: baseDate,
      };
      const buf = kotSlip(ctx, 58);
      const rendered = renderBytes(buf);
      expect(rendered).toMatchSnapshot();
      // Explicit assertion for split rule
      expect(rendered).toContain("T1 / B");
      // Explicit assertion for 58mm hr width
      expect(rendered).toContain("-".repeat(32));
    });

    it("parcel (snapshot)", () => {
      const ctx = {
        kotNo: 44,
        stationName: "Kitchen",
        orderType: "parcel" as const,
        tableName: null,
        splitLabel: null,
        items: [{ qty: 3, name: "Dosa", note: null, cancelled: false }],
        atMs: baseDate,
      };
      const buf = kotSlip(ctx, 80);
      expect(renderBytes(buf)).toMatchSnapshot();
    });

    it("item with note (snapshot)", () => {
      const ctx = {
        kotNo: 45,
        stationName: "Kitchen",
        orderType: "dine_in" as const,
        tableName: "T2",
        splitLabel: "A",
        items: [{ qty: 1, name: "Pizza", note: "No onions", cancelled: false }],
        atMs: baseDate,
      };
      const buf = kotSlip(ctx, 80);
      expect(renderBytes(buf)).toMatchSnapshot();
    });

    it("cancelled item on KOT (snapshot)", () => {
      const ctx = {
        kotNo: 46,
        stationName: "Kitchen",
        orderType: "dine_in" as const,
        tableName: "T3",
        splitLabel: "A",
        items: [
          { qty: 1, name: "Soup", note: null, cancelled: false },
          { qty: 1, name: "Salad", note: null, cancelled: true },
        ],
        atMs: baseDate,
      };
      const buf = kotSlip(ctx, 80);
      expect(renderBytes(buf)).toMatchSnapshot();
    });

    it("split A does NOT include ' / A' suffix (non-snapshot assertion)", () => {
      const ctx = {
        kotNo: 99,
        stationName: "Kitchen",
        orderType: "dine_in" as const,
        tableName: "T5",
        splitLabel: "A",
        items: [{ qty: 1, name: "Item", note: null, cancelled: false }],
        atMs: baseDate,
      };
      const buf = kotSlip(ctx, 80);
      const rendered = renderBytes(buf);
      // Context line should be plain "T5", not "T5 / A"
      expect(rendered).toContain("T5\n");
      expect(rendered).not.toContain(" / A");
    });
  });

  describe("cancelSlip", () => {
    it("cancel slip 80mm (snapshot)", () => {
      const ctx = {
        kotNo: 42,
        stationName: "Kitchen",
        orderType: "dine_in" as const,
        tableName: "T1",
        splitLabel: "B",
        item: { qty: 1, name: "Biryani (Full)" },
        reason: "Customer changed mind",
        atMs: baseDate,
      };
      const buf = cancelSlip(ctx, 80);
      expect(renderBytes(buf)).toMatchSnapshot();
    });
  });
});
