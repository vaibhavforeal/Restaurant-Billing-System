import { z } from "zod";

/** Static registry of third-party integrations the Marketplace can turn on or off. Only on/off state is stored (integration_state). */
export type IntegrationId = "zomato" | "swiggy";
export type IntegrationStatus = "available" | "coming_soon";

export interface IntegrationDef {
  id: IntegrationId;
  name: string;
  description: string;
  category: "delivery";
  status: IntegrationStatus;
  /** Page the "Set up" action opens once the integration is on; null when there is nothing to configure yet. */
  setupPage: "zomato" | null;
}

export interface IntegrationInfo extends IntegrationDef {
  enabled: boolean;
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
];

export const IntegrationToggle = z.object({ enabled: z.boolean() }).strict();
export type IntegrationToggleInput = z.infer<typeof IntegrationToggle>;

export function isIntegrationId(id: string): id is IntegrationId {
  return INTEGRATIONS.some((integration) => integration.id === id);
}
