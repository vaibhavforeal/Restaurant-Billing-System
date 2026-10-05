import type { StockUnit } from "@forkflow/domain";

export interface RecipeDraftRow {
  key: string;
  stockItemId: string;
  quantity: string;
  displayUnit: StockUnit;
}
export interface RecipeIngredient { stockItemId: string; qtyPerSale: number }

export function recipeUnits(stockUnit: StockUnit): StockUnit[] {
  return stockUnit === "kg" ? ["g", "kg"] : stockUnit === "L" ? ["ml", "L"] : [stockUnit];
}
export const defaultRecipeUnit = (stockUnit: StockUnit): StockUnit => recipeUnits(stockUnit)[0]!;

function scale(stockUnit: StockUnit, displayUnit: StockUnit) {
  if (!recipeUnits(stockUnit).includes(displayUnit)) throw new Error("Choose a compatible ingredient unit.");
  return displayUnit === stockUnit ? 1 : 1000;
}

/** Keep the server's thousandth-of-a-stock-unit precision; never round a recipe. */
export function recipeAmount(text: string, stockUnit: StockUnit, displayUnit: StockUnit): number {
  if (!text.trim() || !Number.isFinite(Number(text))) throw new Error("Enter an amount.");
  const divisor = scale(stockUnit, displayUnit);
  const amount = Number(text) / divisor;
  if (amount < 0.001 || amount > 1_000_000) {
    throw new Error(`Use ${0.001 * divisor} to ${(1_000_000 * divisor).toLocaleString("en-IN")} ${displayUnit}.`);
  }
  const milli = amount * 1000;
  if (Math.abs(milli - Math.round(milli)) > 0.0001) {
    throw new Error(divisor === 1000 ? `Use whole ${displayUnit} for stock measured in ${stockUnit}.` : "Use up to 3 decimal places.");
  }
  return Math.round(milli) / 1000;
}

export function displayRecipeAmount(amount: number, stockUnit: StockUnit, displayUnit: StockUnit): string {
  return String(Number((amount * scale(stockUnit, displayUnit)).toFixed(3)));
}

export function switchRecipeUnit(text: string, stockUnit: StockUnit, from: StockUnit, to: StockUnit): string {
  if (!text.trim() || !Number.isFinite(Number(text))) return text;
  try { return displayRecipeAmount(recipeAmount(text, stockUnit, from), stockUnit, to); } catch { /* Preserve invalid precision for validation. */ }
  // Preserve invalid precision too, so switching units cannot silently fix/round it.
  return String(Number(text) / scale(stockUnit, from) * scale(stockUnit, to));
}

export function recipeIsDirty(rows: RecipeDraftRow[], saved: RecipeIngredient[], unitFor: (id: string) => StockUnit | undefined): boolean {
  if (rows.length !== saved.length || new Set(rows.map((row) => row.stockItemId)).size !== rows.length) return true;
  return rows.some((row) => {
    const unit = unitFor(row.stockItemId);
    if (!unit) return true;
    try {
      const amount = recipeAmount(row.quantity, unit, row.displayUnit);
      return !saved.some((link) => link.stockItemId === row.stockItemId && link.qtyPerSale === amount);
    } catch { return true; }
  });
}

export function recipeWrite(productId: string, expectedVersion: number, ingredients: RecipeIngredient[], fullRecipe: boolean) {
  if (!fullRecipe && ingredients.length > 1) throw new Error("Multiple ingredients require Pro.");
  return fullRecipe
    ? { path: `/api/products/${productId}/recipe`, body: { expectedVersion, ingredients } }
    : { path: `/api/products/${productId}/stock-links`, body: { expectedVersion, stockItemId: ingredients[0]?.stockItemId ?? null, qtyPerSale: ingredients[0]?.qtyPerSale ?? 1 } };
}
