import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { MENU_SCHEMA, type MenuCatalog, type MenuItem } from "./schema.js";

const MODEL = "claude-opus-4-8";

const IMAGE_TYPES: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const SYSTEM = `You are a menu-digitization engine for a restaurant POS.
Extract the menu EXACTLY as printed into the provided schema. Rules:
- Preserve the printed order of categories and items.
- Read prices as numbers only, no currency symbol. If a price is illegible or absent, use null — never guess a number.
- If an item has size/portion pricing (Half/Full, S/M/L), put each in "variations" and leave base "price" null unless a single base price is also printed.
- Set "confidence" honestly per item: "low" if the name or price was hard to read, blurry, or ambiguous.
- Do not invent items, categories, descriptions, or prices that are not on the menu.
- veg_status/spice_level: infer only when the menu marks it or the dish is unambiguous; otherwise "unknown".`;

/** Build the vision content block for an image or a PDF. */
function buildSourceBlock(filePath: string): Anthropic.ContentBlockParam {
  const ext = path.extname(filePath).toLowerCase();
  const data = fs.readFileSync(filePath).toString("base64");
  if (ext === ".pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
  }
  const media_type = IMAGE_TYPES[ext];
  if (!media_type) {
    throw new Error(`Unsupported file type "${ext}". Use one of: ${Object.keys(IMAGE_TYPES).join(", ")}, .pdf`);
  }
  return { type: "image", source: { type: "base64", media_type, data } };
}

export interface IngestResult {
  catalog: MenuCatalog;
  raw: string;
}

/** Run vision + structured extraction over a single menu file. */
export async function ingestMenu(filePath: string): Promise<IngestResult> {
  const client = new Anthropic(); // resolves ANTHROPIC_API_KEY / auth profile from the environment

  // Streaming keeps a large max_tokens under the SDK's HTTP timeout; structured
  // output guarantees the final text is schema-valid JSON.
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: "adaptive" }, // a little reasoning materially improves layout/price association
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema: MENU_SCHEMA } },
    messages: [
      {
        role: "user",
        content: [
          buildSourceBlock(filePath),
          { type: "text", text: "Digitize this menu into the required JSON schema." },
        ],
      },
    ],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error("Model refused the request (safety). Try a different image.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("Hit max_tokens before finishing — the menu is very large. Split it into pages and retry.");
  }

  const text = message.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
  if (!text) throw new Error("No text block in the response.");

  return { catalog: JSON.parse(text) as MenuCatalog, raw: text };
}

// ---- Post-extraction review layer (the "trust" half — done in code, not by the model) ----

export interface ReviewFlag {
  category: string;
  item: string;
  reason: string;
}

export interface ReviewReport {
  itemCount: number;
  categoryCount: number;
  medianPrice: number | null;
  flags: ReviewFlag[];
}

/** Effective price of an item = base price, or the min of its variation prices. */
function effectivePrice(item: MenuItem): number | null {
  if (item.price != null) return item.price;
  const varPrices = item.variations.map((v) => v.price).filter((p): p is number => p != null);
  return varPrices.length ? Math.min(...varPrices) : null;
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Flag everything a human must eyeball before this catalog can be billed on:
 * low-confidence reads, missing prices, and price outliers (>10x or <1/10x the median).
 */
export function review(catalog: MenuCatalog): ReviewReport {
  const flags: ReviewFlag[] = [];
  const prices: number[] = [];
  let itemCount = 0;

  for (const cat of catalog.categories) {
    for (const item of cat.items) {
      itemCount++;
      const p = effectivePrice(item);
      if (p != null) prices.push(p);
    }
  }

  const med = prices.length ? median(prices) : null;

  for (const cat of catalog.categories) {
    for (const item of cat.items) {
      const push = (reason: string) => flags.push({ category: cat.name, item: item.name, reason });
      if (item.confidence === "low") push("low-confidence read — verify name & price");
      const p = effectivePrice(item);
      if (p == null) {
        push("no price found — enter manually");
      } else if (med != null && med > 0 && (p > med * 10 || p < med / 10)) {
        push(`price ${p} is a statistical outlier (median ${med}) — likely a misread`);
      }
    }
  }

  return {
    itemCount,
    categoryCount: catalog.categories.length,
    medianPrice: med,
    flags,
  };
}
