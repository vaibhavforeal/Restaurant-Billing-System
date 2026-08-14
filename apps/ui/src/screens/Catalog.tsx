import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { paiseToRupees } from "../money";
import type { Category, Product, Station } from "../types";
import { ProductEditor } from "./ProductEditor";

export function Catalog() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [selectedCat, setSelectedCat] = useState<string | null>(null);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [newCatName, setNewCatName] = useState("");
  const [error, setError] = useState("");

  async function reload() {
    const [c, p, s] = await Promise.all([
      apiFetch<{ categories: Category[] }>("/api/categories"),
      apiFetch<{ products: Product[] }>("/api/products"),
      apiFetch<{ stations: Station[] }>("/api/kot-stations"),
    ]);
    setCategories(c.categories);
    setProducts(p.products);
    setStations(s.stations);
    setSelectedCat((cur) => cur ?? c.categories[0]?.id ?? null);
  }

  useEffect(() => {
    reload().catch(() => setError("Failed to load catalog"));
  }, []);

  async function run(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    }
  }

  function addCategory() {
    const name = newCatName.trim();
    if (!name) return;
    const maxSort = Math.max(0, ...categories.map((c) => c.sortOrder));
    void run(async () => {
      await apiFetch("/api/categories", { method: "POST", body: JSON.stringify({ name, sortOrder: maxSort + 1 }) });
      setNewCatName("");
    });
  }

  function patchCategory(id: string, patch: Partial<Pick<Category, "name" | "sortOrder" | "isActive">>) {
    void run(() => apiFetch(`/api/categories/${id}`, { method: "PATCH", body: JSON.stringify(patch) }));
  }

  /** Swap sortOrder with the neighbor in the current list order. */
  function move(cat: Category, dir: -1 | 1) {
    const i = categories.findIndex((c) => c.id === cat.id);
    const neighbor = categories[i + dir];
    if (!neighbor) return;
    void run(async () => {
      await apiFetch(`/api/categories/${cat.id}`, { method: "PATCH", body: JSON.stringify({ sortOrder: neighbor.sortOrder }) });
      await apiFetch(`/api/categories/${neighbor.id}`, { method: "PATCH", body: JSON.stringify({ sortOrder: cat.sortOrder }) });
    });
  }

  function rename(cat: Category) {
    const name = window.prompt("Category name", cat.name)?.trim();
    if (name && name !== cat.name) patchCategory(cat.id, { name });
  }

  if (editing) {
    return (
      <ProductEditor
        product={editing === "new" ? null : editing}
        defaultCategoryId={selectedCat}
        categories={categories}
        stations={stations}
        onDone={() => {
          setEditing(null);
          void reload();
        }}
      />
    );
  }

  const visible = products.filter((p) => p.categoryId === selectedCat);

  return (
    <div style={{ display: "flex", gap: 24, padding: 16, fontFamily: "system-ui", alignItems: "flex-start" }}>
      <div style={{ width: 260 }}>
        <h2>Categories</h2>
        <div style={{ display: "flex", gap: 4 }}>
          <input value={newCatName} placeholder="New category" onChange={(e) => setNewCatName(e.target.value)} style={{ flex: 1 }} />
          <button onClick={addCategory}>Add</button>
        </div>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {categories.map((c) => (
            <li key={c.id} style={{ display: "flex", gap: 4, alignItems: "center", padding: "4px 0", opacity: c.isActive ? 1 : 0.45 }}>
              <button
                onClick={() => setSelectedCat(c.id)}
                style={{ flex: 1, textAlign: "left", padding: 8, fontWeight: c.id === selectedCat ? 700 : 400 }}
              >
                {c.name}
              </button>
              <button onClick={() => move(c, -1)} title="Move up">▲</button>
              <button onClick={() => move(c, 1)} title="Move down">▼</button>
              <button onClick={() => rename(c)} title="Rename">✎</button>
              <button onClick={() => patchCategory(c.id, { isActive: !c.isActive })} title={c.isActive ? "Deactivate" : "Activate"}>
                {c.isActive ? "⏸" : "▶"}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>Products</h2>
          <button onClick={() => setEditing("new")} disabled={!selectedCat} style={{ padding: "8px 16px" }}>
            New product
          </button>
        </div>
        <div style={{ color: "crimson", minHeight: 20 }}>{error}</div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
              <th style={{ padding: 6 }}>Name</th>
              <th>Price</th>
              <th>GST</th>
              <th>Veg</th>
              <th>Variants</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => (
              <tr key={p.id} style={{ borderBottom: "1px solid #eee", opacity: p.isActive ? 1 : 0.45 }}>
                <td style={{ padding: 6 }}>{p.name}</td>
                <td>₹{paiseToRupees(p.pricePaise)}</td>
                <td>{p.gstRate}%</td>
                <td>{p.isVeg ? "🟢" : "🔴"}</td>
                <td>{p.variants.filter((v) => v.isActive).map((v) => v.name).join(", ") || "—"}</td>
                <td>
                  <button onClick={() => setEditing(p)}>Edit</button>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} style={{ padding: 12, color: "#777" }}>
                  No products in this category yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
