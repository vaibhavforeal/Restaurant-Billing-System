import { z } from "zod";
import type { Feature } from "./licensing.js";

/** Static registry of integrations and add-ons the Marketplace can turn on or off. Only on/off state is stored (integration_state). */
export type IntegrationId = "zomato" | "swiggy" | "kds";
export type IntegrationStatus = "available" | "coming_soon";

export interface IntegrationDef {
  id: IntegrationId;
  name: string;
  description: string;
  category: "delivery" | "kitchen";
  status: IntegrationStatus;
  /** Page the "Set up" action opens once the integration is on; null when there is nothing to configure yet. */
  setupPage: "zomato" | null;
  /** Licence feature the plan must include before this can be turned on; absent when every plan has it. */
  feature?: Feature;
}

export interface IntegrationInfo extends IntegrationDef {
  enabled: boolean;
  /** False when the installation's plan lacks `feature`; the stored switch is kept but has no effect. */
  licensed: boolean;
  updatedAt: number | null;
}

export const INTEGRATIONS: readonly IntegrationDef[] = [
  {
    id: "zomato",
    name: "Zomato",
    description: "Receive Zomato delivery orders, review them and bill them from the counter.",
    category: "delivery",
    status: "available",
    setupPage: "zomato",
  },
  {
    id: "swiggy",
    name: "Swiggy",
    description: "Receive Swiggy delivery orders alongside your dine-in and takeaway orders.",
    category: "delivery",
    status: "coming_soon",
    setupPage: null,
  },
  {
    id: "kds",
    name: "Kitchen Display (KDS)",
    description: "Show KOTs on kitchen screens and tablets so the kitchen can see what to cook and mark tickets done.",
    category: "kitchen",
    status: "available",
    setupPage: null,
    feature: "kds",
  },
];

export const IntegrationToggle = z.object({ enabled: z.boolean() }).strict();
export type IntegrationToggleInput = z.infer<typeof IntegrationToggle>;

export function isIntegrationId(id: string): id is IntegrationId {
  return INTEGRATIONS.some((integration) => integration.id === id);
}
