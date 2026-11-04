import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { usualChips, type LastOrder, type UsualDish } from "../customer-usual";
import { paiseToRupees } from "../money";
import type { Product, Variant } from "../types";

const shortDate = (at: number) => new Date(at).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

/**
 * "Usual for Asha": the attached customer's regular dishes as one-tap buttons, and Repeat last order. Loads when the
 * customer changes; shows nothing while the hub is unreachable, the setting is off or the customer has no history.
 */
export function CustomerUsual({ customer, products, onOrder, disabled, onAdd, onRepeat }: {
  customer: { id: string; name: string };
  products: Product[];
  /** Dishes already on this order, which are not offered again. */
  onOrder: ReadonlySet<string>;
  disabled: boolean;
  onAdd: (product: Product, variant: Variant | null) => void;
  onRepeat: (last: LastOrder) => void;
}) {
  const [data, setData] = useState<{ dishes: UsualDish[]; lastOrder: LastOrder | null } | null>(null);

  useEffect(() => {
    let active = true;
    setData(null);
    apiFetch<{ dishes: UsualDish[]; lastOrder: LastOrder | null }>(`/api/customers/${customer.id}/usual`)
      .then((loaded) => { if (active) setData(loaded); })
      .catch(() => { /* a hint only: leave it out */ });
    return () => { active = false; };
  }, [customer.id]);

  if (!data) return null;
  const chips = usualChips(data.dishes, onOrder, products);
  const last = data.lastOrder;
  if (!chips.length && !last?.items.length) return null;
  const firstName = customer.name.trim().split(/\s+/)[0];
  const dishCount = last ? last.items.reduce((sum, item) => sum + item.qty, 0) : 0;
  return <div className="customer-usual" role="group" aria-labelledby="customer-usual-title">
    <span id="customer-usual-title">Usual for {firstName}</span>
    {chips.map(({ product, variant }) => {
      const name = variant ? `${product.name} (${variant.name})` : product.name;
      const price = variant ? variant.pricePaise : product.pricePaise;
      return <button key={product.id} type="button" disabled={disabled} aria-label={`Add ${firstName}'s usual ${name}${product.kind === "combo" ? ", combo" : ""}, ₹${paiseToRupees(price)}`}
        onClick={() => onAdd(product, variant)}>+ {name}<span className="pos-money">₹{paiseToRupees(price)}</span></button>;
    })}
    {last && last.items.length > 0 && <button type="button" className="customer-usual-repeat" disabled={disabled}
      title={`Add everything from bill #${last.billNo} at today's prices`} onClick={() => onRepeat(last)}>
      Repeat last order <small>{shortDate(last.createdAt)} · {dishCount} item{dishCount === 1 ? "" : "s"}</small></button>}
  </div>;
}
