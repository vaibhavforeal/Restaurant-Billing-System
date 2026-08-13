import fs from "node:fs";
import path from "node:path";
import { ingestMenu, review } from "./ingest.js";

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: npm run ingest -- <path-to-menu.(png|jpg|jpeg|webp|gif|pdf)>");
    process.exit(1);
  }
  if (!fs.existsSync(input)) {
    console.error(`File not found: ${input}`);
    process.exit(1);
  }

  console.log(`\n📷  Ingesting: ${input}`);
  const started = Date.now();
  const { catalog } = await ingestMenu(input);
  const report = review(catalog);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  // --- Human-readable summary ---
  console.log(`\n✅  Extracted in ${elapsed}s`);
  console.log(`    currency:    ${catalog.currency}`);
  console.log(`    categories:  ${report.categoryCount}`);
  console.log(`    items:       ${report.itemCount}`);
  console.log(`    median price:${report.medianPrice ?? "n/a"}`);

  console.log(`\n🍽   Catalog preview:`);
  for (const cat of catalog.categories) {
    console.log(`\n  ${cat.name}`);
    for (const item of cat.items) {
      const price =
        item.price != null
          ? String(item.price)
          : item.variations.length
            ? item.variations.map((v) => `${v.name} ${v.price ?? "?"}`).join(" / ")
            : "—";
      const conf = item.confidence === "high" ? "" : `  [${item.confidence}]`;
      console.log(`    • ${item.name}  —  ${price}${conf}`);
    }
  }

  // --- Review flags (the trust gate) ---
  if (report.flags.length) {
    console.log(`\n⚠️   ${report.flags.length} item(s) need a human glance before going live:`);
    for (const f of report.flags) {
      console.log(`    - [${f.category}] ${f.item}: ${f.reason}`);
    }
  } else {
    console.log(`\n✔   No review flags — but always spot-check prices before billing.`);
  }

  // --- Persist the structured catalog ---
  const out = path.join(
    path.dirname(input),
    `${path.basename(input, path.extname(input))}.catalog.json`,
  );
  fs.writeFileSync(out, JSON.stringify(catalog, null, 2));
  console.log(`\n💾  Wrote structured catalog → ${out}\n`);
}

main().catch((err) => {
  console.error(`\n❌  ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
