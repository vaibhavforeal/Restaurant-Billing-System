import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api";
import { paiseToRupees, rupeesToPaise } from "../money";
import { useNavigationGuard } from "../navigation-guard";
import { prepareProductPhoto } from "../product-photo";
import type { Category, Product, Station, Variant } from "../types";
import "../product-editor.css";

const optionalPrice = (value: number | null | undefined) => value == null ? "" : paiseToRupees(value);
const emptyVariant = { name: "", price: "", acPrice: "", takeawayPrice: "" };

const GST_RATES = [0, 5, 12, 18, 28];

export function ProductEditor({ product, defaultCategoryId, categories, stations, onDone }: {
  product: Product | null; defaultCategoryId: string | null; categories: Category[];
  stations: Station[]; onDone: () => void;
}) {
  const initial = useRef({ name: product?.name ?? "", description: product?.description ?? "",
    categoryId: product?.categoryId ?? defaultCategoryId ?? "", price: product ? paiseToRupees(product.pricePaise) : "",
    acPrice: optionalPrice(product?.acPricePaise), takeawayPrice: optionalPrice(product?.takeawayPricePaise),
    gstRate: product?.gstRate ?? 5, isVeg: product?.isVeg ?? true, stationId: product?.kotStationId ?? "",
    isActive: product?.isActive ?? true, isSoldOut: product?.isSoldOut ?? false }).current;
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [categoryId, setCategoryId] = useState(initial.categoryId);
  const [price, setPrice] = useState(initial.price);
  const [acPrice, setAcPrice] = useState(initial.acPrice);
  const [takeawayPrice, setTakeawayPrice] = useState(initial.takeawayPrice);
  const [editingVariantId, setEditingVariantId] = useState<string | null>(null);
  const [gstRate, setGstRate] = useState(initial.gstRate);
  const [isVeg, setIsVeg] = useState(initial.isVeg);
  const [stationId, setStationId] = useState(initial.stationId);
  const [isActive, setIsActive] = useState(initial.isActive);
  const [isSoldOut, setIsSoldOut] = useState(initial.isSoldOut);
  const [variants, setVariants] = useState<Variant[]>(product?.variants ?? []);
  const [newVariant, setNewVariant] = useState(emptyVariant);
  // undefined means preserve the stored photo, even if its preview never loaded.
  const [photoChange, setPhotoChange] = useState<string | null | undefined>(undefined);
  const [currentPhoto, setCurrentPhoto] = useState<string | null>(null);
  const [photoLoading, setPhotoLoading] = useState(Boolean(product?.photoVersion));
  const [photoError, setPhotoError] = useState("");
  const [photoReload, setPhotoReload] = useState(0);
  const [busy, setBusy] = useState<"product" | "variant" | "photo" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const localId = useRef(0);
  const preview = photoChange === undefined ? currentPhoto : photoChange;
  const dirty = name !== initial.name || description !== initial.description || categoryId !== initial.categoryId ||
    acPrice !== initial.acPrice || takeawayPrice !== initial.takeawayPrice || price !== initial.price || gstRate !== initial.gstRate || isVeg !== initial.isVeg || stationId !== initial.stationId ||
    isActive !== initial.isActive || isSoldOut !== initial.isSoldOut || photoChange !== undefined ||
    (!product && variants.length > 0) || newVariant.name !== "" || newVariant.price !== "" || newVariant.acPrice !== "" || newVariant.takeawayPrice !== "";

  function canLeave() {
    if (lock.current) { window.alert("Wait for the photo or product changes to finish saving before leaving."); return false; }
    return !dirty || window.confirm("Discard your unsaved product changes?");
  }
  useNavigationGuard(canLeave);
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);

  useEffect(() => {
    if (!product?.photoVersion) { setPhotoLoading(false); return; }
    const controller = new AbortController();
    setPhotoLoading(true); setPhotoError("");
    void apiFetch<{ photo: string | null }>(`/api/products/${product.id}/photo`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
      .then((result) => { if (!controller.signal.aborted) setCurrentPhoto(result.photo); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setPhotoError(cause instanceof Error ? cause.message : "Could not load the saved photo"); })
      .finally(() => { if (!controller.signal.aborted) setPhotoLoading(false); });
    return () => controller.abort();
  }, [product?.id, product?.photoVersion, photoReload]);

  async function run(kind: "product" | "variant" | "photo", action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(kind); setError(""); setMessage("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Request failed"); }
    finally { lock.current = false; setBusy(null); }
  }

  function servicePrices(ac: string, takeaway: string) {
    const acPricePaise = ac.trim() ? rupeesToPaise(ac) : null;
    const takeawayPricePaise = takeaway.trim() ? rupeesToPaise(takeaway) : null;
    if ((ac.trim() && acPricePaise === null) || (takeaway.trim() && takeawayPricePaise === null)) throw new Error("AC and takeaway prices must be valid amounts or blank.");
    return { acPricePaise, takeawayPricePaise };
  }

  function save() {
    const pricePaise = rupeesToPaise(price);
    if (!name.trim() || pricePaise === null || !categoryId) { setError("Name, category, and a valid price are required."); return; }
    if (editingVariantId || newVariant.name.trim() || newVariant.price.trim() || newVariant.acPrice.trim() || newVariant.takeawayPrice.trim()) { setError("Add the draft variant or clear its name and price before saving the product."); return; }
    void run("product", async () => {
      const base = { ...servicePrices(acPrice, takeawayPrice), categoryId, name: name.trim(), description: description.trim(), pricePaise, gstRate, isVeg,
        kotStationId: stationId || null, isSoldOut, ...(photoChange === undefined ? {} : { photo: photoChange }) };
      if (product) await apiFetch(`/api/products/${product.id}`, { method: "PATCH", body: JSON.stringify({ ...base, isActive }) });
      else await apiFetch("/api/products", { method: "POST", body: JSON.stringify({ ...base, variants: variants.map((variant) => ({ name: variant.name, pricePaise: variant.pricePaise, acPricePaise: variant.acPricePaise, takeawayPricePaise: variant.takeawayPricePaise })) }) });
      lock.current = false; onDone();
    });
  }

  function addVariant() {
    const vPrice = rupeesToPaise(newVariant.price), vName = newVariant.name.trim();
    if (!vName || vPrice === null) { setError("Variant needs a name and a valid price."); return; }
    void run("variant", async () => {
      const prices = servicePrices(newVariant.acPrice, newVariant.takeawayPrice);
      if (editingVariantId) {
        const value = { name: vName, pricePaise: vPrice, ...prices };
        const variant = product ? (await apiFetch<{ variant: Variant }>(`/api/variants/${editingVariantId}`, { method: "PATCH", body: JSON.stringify(value) })).variant : { ...variants.find((v) => v.id === editingVariantId)!, ...value };
        setVariants((current) => current.map((v) => v.id === editingVariantId ? variant : v));
        setMessage(product ? "Variant saved." : "Variant updated in this draft.");
      } else if (product) {
        const { variant } = await apiFetch<{ variant: Variant }>(`/api/products/${product.id}/variants`, { method: "POST", body: JSON.stringify({ name: vName, pricePaise: vPrice, ...prices }) });
        setVariants((current) => [...current, variant]); setMessage("Variant saved.");
      } else {
        setVariants((current) => [...current, { id: `local-${localId.current++}`, name: vName, pricePaise: vPrice, ...prices, isActive: true }]);
        setMessage("Variant added to this draft.");
      }
      setNewVariant(emptyVariant); setEditingVariantId(null);
    });
  }

  function toggleVariant(variant: Variant) {
    void run("variant", async () => {
      if (!product) { setVariants((current) => current.filter((value) => value.id !== variant.id)); return; }
      const result = await apiFetch<{ variant: Variant }>(`/api/variants/${variant.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !variant.isActive }) });
      setVariants((current) => current.map((value) => value.id === result.variant.id ? result.variant : value));
      setMessage("Variant availability saved.");
    });
  }

  function choosePhoto(file: File) {
    void run("photo", async () => { setPhotoChange(await prepareProductPhoto(file)); setMessage("Photo ready to save with this product."); });
  }

  return <section className="product-editor panel" aria-label="Product editor">
    <div className="product-editor-heading"><h2>{product ? `Edit: ${product.name}` : "New product"}</h2><span role="status">{dirty ? "Unsaved changes" : ""}</span></div>
    <form onSubmit={(event) => { event.preventDefault(); save(); }}>
      <div className="product-editor-layout"><div className="product-editor-fields">
        <label className="product-field-wide">Product name<input required value={name} disabled={busy !== null} onChange={(event) => setName(event.target.value)} /></label>
        <details className="product-field-wide"><summary>Description (optional)</summary><label className="product-field-wide">Menu description<textarea maxLength={500} rows={4} value={description} disabled={busy !== null} onChange={(event) => setDescription(event.target.value)} placeholder="Describe the dish, its ingredients, or how it is served." /><small>{description.length}/500 characters · Shown on the guest menu.</small></label></details>
        <label>Category<select required value={categoryId} disabled={busy !== null} onChange={(event) => setCategoryId(event.target.value)}><option value="">Choose a category</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}{category.isActive ? "" : " (inactive)"}</option>)}</select></label>
        <label>Non-AC price (₹)<input required inputMode="decimal" value={price} disabled={busy !== null} onChange={(event) => setPrice(event.target.value)} /></label>
        <label>AC price (₹)<input inputMode="decimal" value={acPrice} placeholder="Same as Non-AC" disabled={busy !== null} onChange={(event) => setAcPrice(event.target.value)} /></label>
        <label>Takeaway price (₹)<input inputMode="decimal" value={takeawayPrice} placeholder="Same as Non-AC" disabled={busy !== null} onChange={(event) => setTakeawayPrice(event.target.value)} /></label>
        <p className="product-field-wide product-editor-help">Leave AC or takeaway blank to use the Non-AC price. Portion prices are set separately below.</p>
        <label>GST rate<select value={gstRate} disabled={busy !== null} onChange={(event) => setGstRate(Number(event.target.value))}>{GST_RATES.map((rate) => <option key={rate} value={rate}>{rate}%</option>)}</select></label>
        <label>Kitchen station<select value={stationId} disabled={busy !== null} onChange={(event) => setStationId(event.target.value)}><option value="">No KOT station</option>{stationId && !stations.some((station) => station.id === stationId) && <option value={stationId}>Current inactive station</option>}{stations.map((station) => <option key={station.id} value={station.id}>{station.name}</option>)}</select></label>
        <div className="product-field-wide product-editor-options"><label><input type="checkbox" checked={isVeg} disabled={busy !== null} onChange={(event) => setIsVeg(event.target.checked)} /> Vegetarian</label><label><input type="checkbox" checked={isSoldOut} disabled={busy !== null} onChange={(event) => setIsSoldOut(event.target.checked)} /> Sold out</label>{product && <label><input type="checkbox" checked={isActive} disabled={busy !== null} onChange={(event) => setIsActive(event.target.checked)} /> Active in catalog</label>}</div>
        <p className="product-field-wide product-editor-help">Sold-out items stay visible but cannot be added to new orders. Existing order items stay unchanged. Deactivating hides the product from the menu.</p>
      </div><details className="product-photo-editor" aria-label="Product photo"><summary>Menu photo</summary><div className="pos-section-body">

        {preview ? <img src={preview} alt={`Photo for ${name || "this product"}`} className="product-photo-preview" /> : <div className="product-photo-placeholder">{photoLoading && photoChange === undefined ? "Loading saved photo…" : photoError && photoChange === undefined ? "Saved photo unavailable" : "No photo selected"}</div>}
        <label>Choose a photo<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy !== null} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) choosePhoto(file); }} /></label>
        <p className="product-editor-help">JPEG, PNG, or WebP · Up to 10 MB. The photo is resized and saved on the restaurant PC.</p>
        {busy === "photo" && <p role="status">Preparing photo…</p>}
        {photoError && photoChange === undefined && <p role="alert">{photoError}. Saving other details will preserve the saved photo. <button type="button" disabled={busy !== null || photoLoading} onClick={() => setPhotoReload((value) => value + 1)}>Retry photo</button></p>}
        <div className="product-photo-actions">{preview && <button type="button" disabled={busy !== null} onClick={() => { setPhotoChange(null); setMessage("Photo will be removed when you save."); }}>Remove photo</button>}{photoChange !== undefined && <button type="button" disabled={busy !== null} onClick={() => { setPhotoChange(undefined); setMessage("Photo change discarded."); }}>{product?.photoVersion ? "Keep saved photo" : "Undo photo change"}</button>}</div>
        {photoChange === null && <p role="status" className="product-editor-help">The photo will be removed when saved.</p>}
      </div></details></div>

      <details className="product-variants" aria-label="Product variants"><summary>Variants (portions)</summary><div className="pos-section-body">
        <p className="product-editor-help">{product ? "Changes to variants are saved immediately. Other product details use Save product below." : "Variants will be saved with the new product."}</p>
        {variants.map((variant) => <div className="product-variant-row" key={variant.id}><span>{variant.name} · Non-AC ₹{paiseToRupees(variant.pricePaise)} · AC ₹{paiseToRupees(variant.acPricePaise ?? variant.pricePaise)} · Takeaway ₹{paiseToRupees(variant.takeawayPricePaise ?? variant.pricePaise)}{!variant.isActive && <small>Inactive</small>}</span><button type="button" disabled={busy !== null || editingVariantId !== null || Object.values(newVariant).some(Boolean)} onClick={() => { setEditingVariantId(variant.id); setNewVariant({ name: variant.name, price: paiseToRupees(variant.pricePaise), acPrice: optionalPrice(variant.acPricePaise), takeawayPrice: optionalPrice(variant.takeawayPricePaise) }); }}>Edit prices</button><button type="button" disabled={busy !== null || editingVariantId === variant.id} onClick={() => toggleVariant(variant)}>{product ? variant.isActive ? "Deactivate" : "Activate" : "Remove"}</button></div>)}
        <div className="product-variant-inputs"><label>Variant name<input value={newVariant.name} disabled={busy !== null} placeholder="e.g. Half" onChange={(event) => setNewVariant({ ...newVariant, name: event.target.value })} /></label><label>Variant Non-AC price (₹)<input value={newVariant.price} disabled={busy !== null} inputMode="decimal" onChange={(event) => setNewVariant({ ...newVariant, price: event.target.value })} /></label><label>Variant AC price (₹)<input inputMode="decimal" value={newVariant.acPrice} placeholder="Same as Non-AC" disabled={busy !== null} onChange={(event) => setNewVariant({ ...newVariant, acPrice: event.target.value })} /></label><label>Variant takeaway price (₹)<input inputMode="decimal" value={newVariant.takeawayPrice} placeholder="Same as Non-AC" disabled={busy !== null} onChange={(event) => setNewVariant({ ...newVariant, takeawayPrice: event.target.value })} /></label><button type="button" disabled={busy !== null} onClick={addVariant}>{editingVariantId ? "Save variant" : "Add variant"}</button>{editingVariantId && <button type="button" disabled={busy !== null} onClick={() => { setEditingVariantId(null); setNewVariant(emptyVariant); }}>Cancel variant edit</button>}</div>
      </div></details>
      {error && <p className="error-message" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      <div className="product-editor-actions"><button className="primary" disabled={busy !== null}>{busy === "product" ? "Saving product…" : "Save product"}</button><button type="button" disabled={busy !== null} onClick={() => { if (canLeave()) onDone(); }}>{product ? "Close" : "Cancel"}</button></div>
    </form>
  </section>;
}
