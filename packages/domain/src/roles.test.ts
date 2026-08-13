import { can } from "@forkflow/core";
import { describe, expect, it } from "vitest";
import { roleFor } from "./roles.js";

describe("roleFor", () => {
  it("admin can do everything", () => {
    expect(can(roleFor("admin"), "users.manage")).toBe(true);
    expect(can(roleFor("admin"), "bills.void")).toBe(true);
  });

  it("waiter can take orders and send KOTs but cannot bill or manage", () => {
    const waiter = roleFor("waiter");
    expect(can(waiter, "orders.create")).toBe(true);
    expect(can(waiter, "kots.create")).toBe(true);
    expect(can(waiter, "catalog.read")).toBe(true);
    expect(can(waiter, "bills.create")).toBe(false);
    expect(can(waiter, "users.manage")).toBe(false);
  });

  it("cashier can bill and settle but not manage users or settings", () => {
    const cashier = roleFor("cashier");
    expect(can(cashier, "bills.create")).toBe(true);
    expect(can(cashier, "bills.settle")).toBe(true);
    expect(can(cashier, "orders.create")).toBe(true);
    expect(can(cashier, "users.manage")).toBe(false);
    expect(can(cashier, "settings.manage")).toBe(false);
  });

  it("kitchen can only read and update KOTs", () => {
    const kitchen = roleFor("kitchen");
    expect(can(kitchen, "kots.read")).toBe(true);
    expect(can(kitchen, "kots.update")).toBe(true);
    expect(can(kitchen, "orders.create")).toBe(false);
    expect(can(kitchen, "bills.create")).toBe(false);
  });

  it("unknown role fails closed", () => {
    const ghost = roleFor("ghost" as any);
    expect(can(ghost, "orders.read")).toBe(false);
    expect(can(ghost, "users.manage")).toBe(false);
  });
});
