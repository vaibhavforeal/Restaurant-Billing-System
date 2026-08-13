// The menu catalog schema the model is forced to emit.
//
// Structured-output rules (Claude API): every object needs `additionalProperties: false`
// and lists every property in `required`; nullable values use `anyOf` (numeric
// min/max constraints are NOT supported, so price sanity is enforced in code, not schema).

const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] };

const priced = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", description: "Exactly as printed on the menu." },
    price: {
      ...nullableNumber,
      description: "Numeric price only (no currency symbol). null if not printed / illegible.",
    },
  },
  required: ["name", "price"],
} as const;

export const MENU_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    currency: {
      type: "string",
      description: "ISO-like currency code inferred from symbols (e.g. INR, USD). 'unknown' if unclear.",
    },
    categories: {
      type: "array",
      description: "Menu sections in the order they appear.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string", description: "Original dish name, verbatim." },
                normalized_name: {
                  type: "string",
                  description: "Latin-script/normalized name for search. Same as name if already Latin.",
                },
                description: { type: "string", description: "Printed description, or '' if none." },
                price: {
                  ...nullableNumber,
                  description: "Base price, number only. null if only variations are priced, or if illegible.",
                },
                variations: {
                  type: "array",
                  description: "Size/portion options with their own price (Half/Full, Small/Large, etc.).",
                  items: priced,
                },
                addons: {
                  type: "array",
                  description: "Optional extras/toppings with their own price.",
                  items: priced,
                },
                veg_status: {
                  type: "string",
                  enum: ["veg", "non_veg", "egg", "unknown"],
                  description: "From veg/non-veg marks or dish knowledge. 'unknown' if not derivable.",
                },
                spice_level: {
                  type: "string",
                  enum: ["none", "mild", "medium", "hot", "unknown"],
                },
                confidence: {
                  type: "string",
                  enum: ["high", "medium", "low"],
                  description: "How sure you are the name+price were read correctly. Be honest.",
                },
              },
              required: [
                "name",
                "normalized_name",
                "description",
                "price",
                "variations",
                "addons",
                "veg_status",
                "spice_level",
                "confidence",
              ],
            },
          },
        },
        required: ["name", "items"],
      },
    },
  },
  required: ["currency", "categories"],
} as const;

// ---- TS mirror of the schema (for post-processing) ----
export type Priced = { name: string; price: number | null };
export interface MenuItem {
  name: string;
  normalized_name: string;
  description: string;
  price: number | null;
  variations: Priced[];
  addons: Priced[];
  veg_status: "veg" | "non_veg" | "egg" | "unknown";
  spice_level: "none" | "mild" | "medium" | "hot" | "unknown";
  confidence: "high" | "medium" | "low";
}
export interface MenuCategory {
  name: string;
  items: MenuItem[];
}
export interface MenuCatalog {
  currency: string;
  categories: MenuCategory[];
}
