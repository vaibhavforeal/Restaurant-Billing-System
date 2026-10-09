import { useEffect, useMemo, useState } from "react";
import type { DishCost } from "@forkflow/domain";
import { PRICE_TIER_LABELS } from "@forkflow/domain/pricing";
import { apiFetch } from "../api";
import { COSTING_PRO_NOTE, formatTierPrice, sortDishes } from "../dish-costing";
import { formatMovementCost } from "../stock-costs";
import { useIntegrations } from "../integrations";

const TIERS = ["non_ac", "ac", "takeaway", "zomato"] as const;
const cell = { padding: "6px 10px", verticalAlign: "top" } as const;

export function DishCosting({ fullRecipe, refresh }: { fullRecipe: boolean; refresh: number }) {
  const { isEnabled } = useIntegrations();
  const tiers = TIERS.filter((tier) => tier !== "zomato" || isEnabled("zomato"));
  const [data, setData] = useState<{ dishes: DishCost[]; taxInclusive: boolean } | null>(null);
  const [error, setError] = useState("");
  const [category, setCategory] = useState("all");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!fullRecipe) { setData(null); setError(""); return; }
    const controller = new AbortController();
    apiFetch<{ dishes: DishCost[]; taxInclusive: boolean }>("/api/costing/dishes", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
      .then((result) => { if (!controller.signal.aborted) { setData(result); setError(""); } })
      .catch((e: unknown) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not load dish costing"); });
    return () => controller.abort();
  }, [fullRecipe, refresh, retry]);
  const categories = useMemo(() => [...new Set((data?.dishes ?? []).map((dish) => dish.categoryName))].sort((a, b) => a.localeCompare(b)), [data]);
  // A category that disappears after a refresh would leave an empty, unexplained table.
  const activeCategory = category === "all" || categories.includes(category) ? category : "all";
  const { costed, noRecipe } = useMemo(() => sortDishes(data?.dishes ?? [], activeCategory), [data, activeCategory]);

  if (!fullRecipe) return <section className="dish-costing" aria-label="Dish costing">
    <p className="recipe-access-note">{COSTING_PRO_NOTE}</p>
  </section>;

  return <section className="dish-costing" aria-label="Dish costing">
    <h3>Dish costing</h3>
    <p className="muted">Current recipe cost at today's average ingredient costs, against each selling price before GST{data?.taxInclusive ? " (menu prices include GST)" : ""}. Highest cost % first.</p>
    {error && <div className="recipe-error"><p role="alert">{error}</p><button onClick={() => setRetry((value) => value + 1)}>Retry</button></div>}
    {!data && !error && <p role="status">Loading dish costing…</p>}
    {data && <>
      <label style={{ display: "grid", gap: 6, maxWidth: 280, margin: "12px 0" }}>Category
        <select value={activeCategory} onChange={(event) => setCategory(event.target.value)}>
          <option value="all">All categories</option>
          {categories.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      <div style={{ overflowX: "auto" }}>
        <table aria-label="Dish costing" style={{ width: "100%", textAlign: "left", borderSpacing: 0 }}>
          <thead><tr>
            <th scope="col" style={cell}>Dish</th><th scope="col" style={cell}>Recipe cost</th>
            {tiers.map((tier) => <th key={tier} scope="col" style={cell}>{PRICE_TIER_LABELS[tier]} <small>(price · cost % · margin)</small></th>)}
            <th scope="col" style={cell}>Status</th>
          </tr></thead>
          <tbody>{costed.map((dish) => <tr key={`${dish.productId}:${dish.variantId ?? ""}`}>
            <th scope="row" style={cell}>{dish.name}<br /><small className="muted">{dish.categoryName}</small></th>
            <td style={cell}>{dish.costPaise === null ? "Cost unknown" : formatMovementCost(dish.costPaise)}</td>
            {tiers.map((tier) => <td key={tier} style={cell}>{formatTierPrice(dish.prices.find((price) => price.tier === tier))}</td>)}
            <td style={cell}>{dish.status === "incomplete" ? `Incomplete — missing cost for ${dish.missing.join(", ")}` : "Complete"}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {!costed.length && <p>No costed dishes in this view.</p>}
      <h4 style={{ marginTop: 20 }}>No recipe linked</h4>
      {noRecipe.length
        ? <ul>{noRecipe.map((dish) => <li key={`${dish.productId}:${dish.variantId ?? ""}`}>{dish.name} <small className="muted">({dish.categoryName})</small></li>)}</ul>
        : <p>Every dish in this view has a recipe.</p>}
    </>}
  </section>;
}
