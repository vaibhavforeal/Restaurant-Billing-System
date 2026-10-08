import { describe, expect, it } from "vitest";
import { INTEGRATIONS, IntegrationToggle, isIntegrationId } from "./integrations.js";

describe("integration registry", () => {
  it("lists Zomato, Swiggy (coming soon) and the Kitchen Display", () => {
    expect(INTEGRATIONS.map((i) => i.id)).toEqual(["zomato", "swiggy", "kds"]);
    const [zomato, swiggy] = INTEGRATIONS;
    expect(zomato).toMatchObject({ status: "available", setupPage: "zomato", category: "delivery" });
    expect(swiggy).toMatchObject({ status: "coming_soon", setupPage: null, category: "delivery" });
  });

  it("defines the Kitchen Display as a Pro-licensed kitchen add-on", () => {
    expect(INTEGRATIONS.find((i) => i.id === "kds")).toEqual({
      id: "kds", name: "Kitchen Display (KDS)",
      description: "Show KOTs on kitchen screens and tablets so the kitchen can see what to cook and mark tickets done.",
      category: "kitchen", status: "available", setupPage: null, feature: "kds",
    });
  });

  it("recognises only registered ids", () => {
    expect(isIntegrationId("zomato")).toBe(true);
    expect(isIntegrationId("swiggy")).toBe(true);
    expect(isIntegrationId("dineout")).toBe(false);
    expect(isIntegrationId("__proto__")).toBe(false);
  });

  it("accepts only a strict boolean toggle body", () => {
    expect(IntegrationToggle.safeParse({}).success).toBe(false);
    expect(IntegrationToggle.safeParse({ enabled: "yes" }).success).toBe(false);
    expect(IntegrationToggle.safeParse({ enabled: true, x: 1 }).success).toBe(false);
    expect(IntegrationToggle.safeParse({ enabled: false }).success).toBe(true);
  });
});
