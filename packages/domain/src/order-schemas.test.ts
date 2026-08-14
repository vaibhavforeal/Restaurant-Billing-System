import { describe, expect, it } from "vitest";
import {
  TableCreate, TableUpdate,
  OrderCreate, OrderItemsAdd, OrderItemUpdate, ItemCancel,
} from "./index.js";

describe("table schemas", () => {
  it("TableCreate defaults sortOrder to 0, area to null, and trims name", () => {
    expect(TableCreate.parse({ name: "  T1 " })).toEqual({ name: "T1", area: null, sortOrder: 0 });
  });

  it("TableCreate rejects empty names", () => {
    expect(() => TableCreate.parse({ name: "  " })).toThrow();
  });

  it("TableUpdate accepts partial fields including nullable area", () => {
    expect(TableUpdate.parse({ area: "Patio", sortOrder: 5 })).toEqual({ area: "Patio", sortOrder: 5 });
    expect(TableUpdate.parse({ area: null })).toEqual({ area: null });
  });
});

describe("order schemas", () => {
  it("OrderCreate requires clientRef 8-64 chars, defaults tableId to null", () => {
    const parcel = OrderCreate.parse({ clientRef: "abcd1234", type: "parcel" });
    expect(parcel).toEqual({ clientRef: "abcd1234", type: "parcel", tableId: null });

    expect(() => OrderCreate.parse({ clientRef: "short", type: "parcel" })).toThrow();
    expect(() => OrderCreate.parse({ clientRef: "x".repeat(65), type: "parcel" })).toThrow();
  });

  it("OrderCreate dine_in requires tableId, parcel must not have tableId", () => {
    expect(OrderCreate.parse({ clientRef: "ref12345", type: "dine_in", tableId: "table-1" }))
      .toEqual({ clientRef: "ref12345", type: "dine_in", tableId: "table-1" });

    // dine_in without tableId fails
    expect(() => OrderCreate.parse({ clientRef: "ref12345", type: "dine_in" })).toThrow(/dine_in requires tableId/);

    // parcel with tableId fails
    expect(() => OrderCreate.parse({ clientRef: "ref12345", type: "parcel", tableId: "table-1" }))
      .toThrow(/parcel cannot have a table/);
  });

  it("OrderItemsAdd requires at least one item with qty 1-99", () => {
    const valid = OrderItemsAdd.parse({
      items: [
        { productId: "p1", qty: 5 },
        { productId: "p2", variantId: "v1", qty: 99, note: "Extra spicy" },
      ],
    });
    expect(valid.items).toHaveLength(2);
    expect(valid.items[0]).toEqual({ productId: "p1", variantId: null, qty: 5 });
    expect(valid.items[1]?.note).toBe("Extra spicy");

    // Empty items array rejected
    expect(() => OrderItemsAdd.parse({ items: [] })).toThrow();

    // qty bounds
    expect(() => OrderItemsAdd.parse({ items: [{ productId: "p1", qty: 0 }] })).toThrow();
    expect(() => OrderItemsAdd.parse({ items: [{ productId: "p1", qty: 100 }] })).toThrow();
  });

  it("OrderItemsAdd clientRef length bounds and optional usage", () => {
    // clientRef optional, but when provided must be 8-64
    const withRef = OrderItemsAdd.parse({
      items: [{ clientRef: "item-ref-12345", productId: "p1", qty: 1 }],
    });
    expect(withRef.items[0]?.clientRef).toBe("item-ref-12345");

    expect(() =>
      OrderItemsAdd.parse({ items: [{ clientRef: "short", productId: "p1", qty: 1 }] })
    ).toThrow();
    expect(() =>
      OrderItemsAdd.parse({ items: [{ clientRef: "x".repeat(65), productId: "p1", qty: 1 }] })
    ).toThrow();
  });

  it("OrderItemUpdate accepts partial qty/note with nullable note", () => {
    expect(OrderItemUpdate.parse({ qty: 3 })).toEqual({ qty: 3 });
    expect(OrderItemUpdate.parse({ note: "Medium spice" })).toEqual({ note: "Medium spice" });
    expect(OrderItemUpdate.parse({ note: null })).toEqual({ note: null });

    // qty bounds
    expect(() => OrderItemUpdate.parse({ qty: 0 })).toThrow();
    expect(() => OrderItemUpdate.parse({ qty: 100 })).toThrow();
  });

  it("ItemCancel has optional reason with trimming and max 200 chars", () => {
    expect(ItemCancel.parse({})).toEqual({});
    expect(ItemCancel.parse({ reason: "  Customer changed mind " })).toEqual({ reason: "Customer changed mind" });
    expect(() => ItemCancel.parse({ reason: "x".repeat(201) })).toThrow();
  });
});
