import { useRef, useState } from "react";
import { ApiError, apiFetch } from "../api";
import { paiseToRupees, rupeesToPaise } from "../money";
import type { Category, Product, Station, Variant } from "../types";

const GST_RATES = [0, 5, 12, 18, 28];
const row = { display: "flex", gap: 8, alignItems: "center" } as const;

export function ProductEditor({
  product,
  defaultCategoryId,
  categories,
  stations,
  onDone,
}: {
  product: Product | null;
  defaultCategoryId: string | null;
  categories: Category[];
  stations: Station[];
  onDone: () => void;
}) {
  const [name, setName] = useState(product?.name ?? "");
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? defaultCategoryId ?? "");
  const [price, setPrice] = useState(product ? paiseToRupees(product.pricePaise) : "");
  const [gstRate, setGstRate] = useState(product?.gstRate ?? 5);
  const [isVeg, setIsVeg] = useState(product?.isVeg ?? true);
  const [stationId, setStationId] = useState(product?.kotStationId ?? "");
  const [isActive, setIsActive] = useState(product?.isActive ?? true);
  // create mode collects variants locally; edit mode reflects the server list
  const [variants, setVariants] = useState<Variant[]>(product?.variants ?? []);
  const [newVariant, setNewVariant] = useState({ name: "", price: "" });
  const [error, setError] = useState("");
  const localIdRef = useRef(0);

  function fail(e: unknown) {
    setError(e instanceof ApiError ? e.message : "Request failed");
  }

  async function save() {
    setError("");
    const pricePaise = rupeesToPaise(price);
    if (!name.trim() || pricePaise === null || !categoryId) {
      return setError("Name, category, and a valid price are required");
    }
    const base = {
      categoryId,
      name: name.trim(),
      pricePaise,
      gstRate,
      isVeg,
      kotStationId: stationId || null,
    };
    try {
      if (product) {
        await apiFetch(`/api/products/${product.id}`, { method: "PATCH", body: JSON.stringify({ ...base, isActive }) });
      } else {
        const inline = variants.map((v) => ({ name: v.name, pricePaise: v.pricePaise }));
        await apiFetch("/api/products", { method: "POST", body: JSON.stringify({ ...base, variants: inline }) });
      }
      onDone();
    } catch (e) {
      fail(e);
    }
  }

  async function addVariant() {
    const vPrice = rupeesToPaise(newVariant.price);
    const vName = newVariant.name.trim();
    if (!vName || vPrice === null) return setError("Variant needs a name and a valid price");
    setError("");
    if (product) {
      try {
        const { variant } = await apiFetch<{ variant: Variant }>(`/api/products/${product.id}/variants`, {
          method: "POST",
          body: JSON.stringify({ name: vName, pricePaise: vPrice }),
        });
        setVariants((vs) => [...vs, variant]);
      } catch (e) {
        return fail(e);
      }
    } else {
      // local-only until the product is created
      setVariants((vs) => [...vs, { id: `local-${localIdRef.current++}`, name: vName, pricePaise: vPrice, isActive: true }]);
    }
    setNewVariant({ name: "", price: "" });
  }

  async function toggleVariant(v: Variant) {
    if (!product) {
      return setVariants((vs) => vs.filter((x) => x.id !== v.id)); // create mode: just remove the local row
    }
    try {
      const { variant } = await apiFetch<{ variant: Variant }>(`/api/variants/${v.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !v.isActive }),
      });
      setVariants((vs) => vs.map((x) => (x.id === variant.id ? variant : x)));
    } catch (e) {
      fail(e);
    }
  }

  return (
    <div style={{ maxWidth: 520, margin: "4vh auto", display: "grid", gap: 12, fontFamily: "system-ui" }}>
      <h2>{product ? `Edit: ${product.name}` : "New product"}</h2>

      <input placeholder="Product name" value={name} onChange={(e) => setName(e.target.value)} />

      <div style={row}>
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Category…</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <input placeholder="Price ₹" value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value)} style={{ width: 100 }} />
        <select value={gstRate} onChange={(e) => setGstRate(Number(e.target.value))}>
          {GST_RATES.map((r) => (
            <option key={r} value={r}>GST {r}%</option>
          ))}
        </select>
      </div>

      <div style={row}>
        <label style={row}>
          <input type="checkbox" checked={isVeg} onChange={(e) => setIsVeg(e.target.checked)} /> Veg
        </label>
        <select value={stationId} onChange={(e) => setStationId(e.target.value)}>
          <option value="">No KOT station</option>
          {stations.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        {product && (
          <label style={row}>
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active
          </label>
        )}
      </div>

      <h3 style={{ marginBottom: 0 }}>Variants (portions)</h3>
      {variants.map((v) => (
        <div key={v.id} style={{ ...row, opacity: v.isActive ? 1 : 0.45 }}>
          <span style={{ flex: 1 }}>{v.name} — ₹{paiseToRupees(v.pricePaise)}</span>
          <button onClick={() => void toggleVariant(v)}>{product ? (v.isActive ? "Deactivate" : "Activate") : "Remove"}</button>
        </div>
      ))}
      <div style={row}>
        <input placeholder="Variant name (e.g. Half)" value={newVariant.name} onChange={(e) => setNewVariant({ ...newVariant, name: e.target.value })} style={{ flex: 1 }} />
        <input placeholder="Price ₹" value={newVariant.price} inputMode="decimal" onChange={(e) => setNewVariant({ ...newVariant, price: e.target.value })} style={{ width: 100 }} />
        <button onClick={() => void addVariant()}>Add</button>
      </div>

      <div style={{ color: "crimson", minHeight: 20 }}>{error}</div>
      <div style={row}>
        <button onClick={() => void save()} style={{ padding: "10px 24px", fontWeight: 700 }}>Save</button>
        <button onClick={onDone} style={{ padding: "10px 24px" }}>{product ? "Close" : "Cancel"}</button>
      </div>
    </div>
  );
}
