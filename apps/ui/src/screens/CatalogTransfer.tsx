import { useRef, useState } from "react";
import { CATALOG_CSV_COLUMNS, CATALOG_CSV_LIMIT, catalogCsv, type CatalogImportPreview } from "@forkflow/domain/catalog-csv";
import { apiFetch } from "../api";
import { paiseToRupees } from "../money";
import { downloadText } from "../download";

function download(csv: string, filename: string) {
  downloadText(csv, filename, "text/csv;charset=utf-8");
}

export function CatalogTransfer({ busy, run, onImported }: {
  busy: boolean;
  run: (action: () => Promise<unknown>, key?: string) => Promise<void>;
  onImported: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [preview, setPreview] = useState<CatalogImportPreview | null>(null);

  async function previewFile(selected: { name: string; csv: string }) {
    setPreview(null);
    const result = await apiFetch<CatalogImportPreview>("/api/catalog/import/preview", {
      method: "POST", body: JSON.stringify({ csv: selected.csv }),
    });
    setPreview(result);
  }

  function chooseFile(selected: File | undefined) {
    if (!selected) return;
    setFile(null); setPreview(null);
    void run(async () => {
      if (selected.size > CATALOG_CSV_LIMIT) throw new Error("CSV must be 5 MB or smaller.");
      const value = { name: selected.name, csv: await selected.text() };
      setFile(value);
      await previewFile(value);
    }, "transfer");
  }

  function importFile() {
    if (!file || !preview) return;
    void run(async () => {
      const result = await apiFetch<CatalogImportPreview>("/api/catalog/import", {
        method: "POST", body: JSON.stringify({ csv: file.csv, revision: preview.revision }),
      });
      setFile(null); setPreview(null);
      onImported(`Import complete: ${result.created} items added, ${result.updated} updated; ${result.variantsCreated} variants added, ${result.variantsUpdated} updated.`);
    }, "transfer");
  }

  return <section className="catalog-transfer" aria-label="Import and export items" aria-busy={busy}>
    <div className="catalog-transfer-actions">
      <button disabled={busy} onClick={() => { void run(async () => {
        const result = await apiFetch<{ csv: string; filename: string }>("/api/catalog/export");
        download(result.csv, result.filename);
      }, "transfer"); }}>Export CSV</button>
      <button disabled={busy} onClick={() => input.current?.click()}>Import CSV</button>
      <button disabled={busy} onClick={() => download(catalogCsv([
        CATALOG_CSV_COLUMNS,
        ["", "Beverages", "Masala chai", "40.00", "5", "true", "true", "false", "Freshly brewed tea", "Kitchen", "", "", "", "", "50.00", "45.00", "", ""],
        ["", "Beverages", "Masala chai", "40.00", "5", "true", "true", "false", "Freshly brewed tea", "Kitchen", "", "Large", "60.00", "true", "50.00", "45.00", "70.00", "65.00"],
      ]), "forkflow-items-template.csv")}>Download template</button>
      <input ref={input} type="file" accept=".csv,text/csv" aria-label="Choose item CSV" hidden disabled={busy}
        onChange={(e) => { chooseFile(e.target.files?.[0]); e.target.value = ""; }} />
      {busy && <span role="status">Working…</span>}
    </div>
    <p className="product-editor-help">All categories · Prices in rupees · Preview before saving</p>
    <details>
      <summary>CSV format and matching rules</summary>
      <p>Use the template or edit an export in Excel, then save as CSV UTF-8. Required columns: category, name and price. The price column is Non-AC; the optional gst_rate column takes 0, 5, 12, 18 or 28, and a blank gst_rate uses the restaurant default GST rate; optional ac_price and takeaway_price set service prices. Portions use variant_ac_price and variant_takeaway_price. Blank service prices use the item or portion's Non-AC price; omitted columns preserve saved prices. Use true/false for flags. Limit: 5 MB and 10,000 rows.</p>
      <p>Keep item_id to update an exported item. With a blank ID, items match by category and name; new names create items. New categories are added automatically. KOT station names must already exist in Settings; blank means no kitchen station.</p>
      <p>Each variant uses another row with identical item details plus variant_name and variant_price. Keep variant_id when updating a variant. Omitted items and variants stay in the database. Blank flags keep existing values; new items default to active, vegetarian and available.</p>
      <p>CSV includes active and inactive items, descriptions and variants. Photos, recipes, stock quantities, category settings and printer settings are not included. Existing photos and stock links are preserved. Blank descriptions clear the description; omit the column to keep it.</p>
    </details>
    {file && <div className="catalog-import-preview">
      <div className="catalog-transfer-actions">
        <strong className="catalog-import-filename">{file.name}</strong>
        <button disabled={busy} onClick={() => { void run(() => previewFile(file), "transfer"); }}>Preview again</button>
        <button disabled={busy} onClick={() => { setFile(null); setPreview(null); }}>Cancel import</button>
      </div>
      {preview && <>
        <p role="status">{preview.created} items to add · {preview.updated} to update · {preview.categoriesCreated} new categories<br />
          {preview.variantsCreated} variants to add · {preview.variantsUpdated} to update</p>
        <div className="catalog-import-table"><table>
          <thead><tr><th>Action</th><th>Item</th><th>Category</th><th>Price</th></tr></thead>
          <tbody>{preview.items.map((item, i) => <tr key={i}>
            <td>{item.action}</td><td>{item.name}</td><td>{item.category}</td><td>₹{paiseToRupees(item.pricePaise)}</td>
          </tr>)}</tbody>
        </table></div>
        <p className="product-editor-help">Updates apply the values in this file. No items or variants will be deleted.</p>
        <button className="primary" disabled={busy} onClick={importFile}>Import {preview.created + preview.updated} items</button>
      </>}
    </div>}
  </section>;
}
