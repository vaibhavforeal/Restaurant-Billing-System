import { AddonGroupsManager } from "./AddonGroupsManager";
import { OffersManager } from "./OffersManager";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api";
import { priceForTier } from "@masalapos/domain/pricing";
import { paiseToRupees } from "../money";
import { useIntegrations } from "../integrations";
import type { AddonGroup, Category, Product, Station, StationInfo } from "../types";
import { ProductEditor } from "./ProductEditor";
import { CatalogTransfer } from "./CatalogTransfer";
import { useNavigationGuard } from "../navigation-guard";
import "../product-editor.css";

function CatalogWriteGuard({ busy }: { busy: boolean }) {
  useNavigationGuard(() => {
    if (!busy) return true;
    window.alert("Wait for the catalog change to finish saving before leaving.");
    return false;
  });
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);
  return null;
}

export function Catalog({ initialOffers = false, onOffersClose }: { initialOffers?: boolean; onOffersClose?: () => void }) {
  const { isEnabled } = useIntegrations();
  const zomato = isEnabled("zomato");
  const [addonGroups, setAddonGroups] = useState<AddonGroup[]>([]);
  const [managingAddons, setManagingAddons] = useState(false);
  const [managingOffers, setManagingOffers] = useState(initialOffers);
  const offersEnabled = isEnabled("offers");
  const [categories, setCategories] = useState<Category[]>([]);
  const [search, setSearch] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [defaultGstRate, setDefaultGstRate] = useState(5);
  const [packagingPerItem, setPackagingPerItem] = useState(false);
  const [stations, setStations] = useState<Station[]>([]);
  const [selectedCat, setSelectedCat] = useState<string | null>(null);
  const [editing, setEditing] = useState<Product | "new" | "new-combo" | null>(null);
  const [newCatName, setNewCatName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const lock = useRef(false);

  async function reload() {
    const [c, p, s, a] = await Promise.all([
      apiFetch<{ categories: Category[] }>("/api/categories"),
      apiFetch<{ products: Product[]; defaultGstRate: number; packagingPerItem?: boolean }>("/api/products"),
      apiFetch<{ stations: StationInfo[] }>("/api/kot-stations"),
      apiFetch<{ groups: AddonGroup[] }>("/api/addon-groups"),
    ]);
    setAddonGroups(a.groups);
    setCategories(c.categories);
    setProducts(p.products);
    setDefaultGstRate(p.defaultGstRate);
    setPackagingPerItem(p.packagingPerItem === true);
    setStations(s.stations.filter((st) => st.isActive));
    setSelectedCat((cur) => cur ?? c.categories[0]?.id ?? null);
  }

  useEffect(() => {
    reload().catch(() => setError("Failed to load catalog"));
  }, []);

  useEffect(() => { if (!offersEnabled) setManagingOffers(false); }, [offersEnabled]);

  async function run(action: () => Promise<unknown>, key = "catalog") {
    if (lock.current) return;
    lock.current = true; setBusy(key); setError(""); setMessage("");
    try {
      await action();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally { lock.current = false; setBusy(null); }
  }

  function toggleAvailability(product: Product) {
    void run(async () => {
      await apiFetch(`/api/products/${product.id}`, { method: "PATCH", body: JSON.stringify({ isSoldOut: !product.isSoldOut }) });
      setMessage(`${product.name} is ${product.isSoldOut ? "enabled" : "disabled"} for new orders.`);
    }, product.id);
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

  if (managingAddons) return <AddonGroupsManager groups={addonGroups} products={products} onChanged={reload} onClose={() => setManagingAddons(false)} />;
  if (managingOffers && offersEnabled) return <OffersManager categories={categories} products={products} onClose={onOffersClose ?? (() => setManagingOffers(false))} />;

  if (editing) {
    return (
      <ProductEditor
        product={editing === "new" || editing === "new-combo" ? null : editing}
        kind={editing === "new-combo" ? "combo" : "item"}
        products={products}
        addonGroups={addonGroups}
        defaultCategoryId={selectedCat}
        categories={categories}
        defaultGstRate={defaultGstRate}
        packagingPerItem={packagingPerItem}
        stations={stations}
        onDone={() => {
          setEditing(null);
          void reload().catch(() => setError("Failed to refresh catalog"));
        }}
      />
    );
  }

  const query = search.trim().toLowerCase();
  const visible = products.filter((p) => query
    ? p.name.toLowerCase().includes(query) || (p.description ?? "").toLowerCase().includes(query)
    : p.categoryId === selectedCat);
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));

  return (
    <div className="catalog-layout">
      <CatalogWriteGuard busy={busy !== null} />
      <aside className="panel category-editor">
        <h2>Categories</h2>
        <div style={{ display: "flex", gap: 4 }}>
          <input value={newCatName} aria-label="New category" disabled={busy !== null} placeholder="New category" onChange={(e) => setNewCatName(e.target.value)} style={{ flex: 1 }} />
          <button className="primary" disabled={busy !== null} onClick={addCategory}>Add</button>
        </div>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {categories.map((c) => (
            <li key={c.id} style={{ display: "flex", gap: 4, alignItems: "center", padding: "4px 0", opacity: c.isActive ? 1 : 0.45 }}>
              <button
                aria-pressed={c.id === selectedCat} onClick={() => { setSearch(""); setSelectedCat(c.id); }}
                style={{ flex: 1, textAlign: "left", padding: 8, fontWeight: c.id === selectedCat ? 700 : 400 }}
              >
                {c.name}
              </button>
              <button disabled={busy !== null} onClick={() => move(c, -1)} title="Move up" aria-label={`Move ${c.name} up`}>▲</button>
              <button disabled={busy !== null} onClick={() => move(c, 1)} title="Move down" aria-label={`Move ${c.name} down`}>▼</button>
              <button disabled={busy !== null} onClick={() => rename(c)} title="Rename" aria-label={`Rename ${c.name}`}>✎</button>
              <button disabled={busy !== null} onClick={() => patchCategory(c.id, { isActive: !c.isActive })} title={c.isActive ? "Deactivate" : "Activate"} aria-label={`${c.isActive ? "Deactivate" : "Activate"} ${c.name}`}>
                {c.isActive ? "⏸" : "▶"}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="panel catalog-products">
        <div className="catalog-products-heading">
          <h2>Products</h2>
          <div className="catalog-create-actions">
            <button disabled={busy !== null} onClick={() => setManagingAddons(true)}>Add-on groups</button>
            {offersEnabled && <button disabled={busy !== null} onClick={() => setManagingOffers(true)}>Offers</button>}
            <button onClick={() => setEditing("new-combo")} disabled={!selectedCat || busy !== null}>
              New combo
            </button>
            <button className="primary" onClick={() => setEditing("new")} disabled={!selectedCat || busy !== null}>
              New product
            </button>
          </div>
        </div>
        {error && <div role="alert" className="error-message">{error}</div>}
        {message && <p role="status">{message}</p>}
        <div className="catalog-table-scroll"><table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
              <th style={{ padding: 6 }}>Name</th>
              <th>Non-AC</th>
              <th>AC</th>
              <th>Takeaway</th>
              {zomato && <th>Zomato</th>}
              <th>GST</th>
              <th>Veg</th>
              <th>Variants</th>
              <th></th>
              <th className="catalog-item-availability">Availability</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => (
              <tr key={p.id} style={{ borderBottom: "1px solid #eee", opacity: p.isActive ? 1 : 0.45 }}>
                <td className="catalog-product-name" style={{ padding: 6 }}><strong>{p.name}</strong>{query && <small>{categoryNames.get(p.categoryId)}</small>}{p.addonOnly && <small>Add-on only</small>}{p.description && <p>{p.description}</p>}{!p.isActive && <small>Inactive · </small>}{p.photoVersion && <small>Photo added</small>}</td>
                <td className="pos-money">₹{paiseToRupees(p.pricePaise)}</td>
                <td className="pos-money">₹{paiseToRupees(p.acPricePaise ?? p.pricePaise)}</td>
                <td className="pos-money">₹{paiseToRupees(p.takeawayPricePaise ?? p.pricePaise)}</td>
                {zomato && <td className="pos-money">₹{paiseToRupees(priceForTier(p, "zomato"))}</td>}
                <td>{p.gstRate === null ? "Default" : `${p.gstRate}%`}</td>
                <td>{p.isVeg ? "🟢" : "🔴"}</td>
                <td>{p.kind === "combo" ? <span className="catalog-combo">Combo · {p.combo?.map((g) => g.name).join(", ") || "no slots yet"}</span> : p.variants.filter((v) => v.isActive).map((v) => v.name).join(", ") || "—"}</td>
                <td><button disabled={busy !== null} onClick={() => setEditing(p)}>Edit</button></td>
                <td className="catalog-item-availability">
                  <button type="button" role="switch" aria-checked={!p.isSoldOut}
                    aria-label={`Enable ${p.name} for new orders`} disabled={busy !== null}
                    onClick={() => toggleAvailability(p)}>
                    <span className="catalog-switch-track" aria-hidden="true" />
                    {p.isSoldOut ? "Disabled" : "Enabled"}
                  </button>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={zomato ? 10 : 9} style={{ padding: 12, color: "var(--muted)" }}>
                  {query ? "No products match your search." : "No products in this category yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table></div>
      </div>
    </div>
  );
}
