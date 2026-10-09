# AC, Non-AC and takeaway prices

In **Catalog → Edit**, enter the Non-AC, AC and takeaway prices in rupees.
The existing base price becomes the Non-AC price. AC and takeaway prices are
optional: leave either blank to use that item's Non-AC price. Zero is an explicit
price, not a blank. GST calculation continues to use the restaurant's GST setting (prices include
GST, or no GST charged) and each item's rate.

Portions have their own three prices under **Variants (portions)**. Use **Edit
prices → Save variant** for an existing portion. A blank portion service price
uses that portion's Non-AC price, rather than the parent item's price. Existing
product variant changes save immediately; variants on a new product save with
the product.

In **Tables → Manage tables**, choose AC or Non-AC pricing for each table.
Area names are for grouping only; naming an area “AC” does not change its prices.
Existing tables default to Non-AC after upgrading. Close all open or billed orders
on a table before changing its pricing. New table orders, split groups and seated
reservations take that table's pricing. Both ordinary parcels and Quick takeaway
automatically use takeaway prices. The order menu identifies the active pricing.

The table's QR menu displays the same prices. Guest requests are checked again
on acceptance; requests whose prices changed must be rejected and resubmitted.

An order remembers its service type, and each saved order line remembers its
actual price. Catalog edits apply to subsequently added lines. Existing lines,
issued bills, receipts, and historical totals retain their saved amounts.

CSV export includes `ac_price`, `takeaway_price`, `variant_ac_price`, and
`variant_takeaway_price`, all in rupees. `price` and `variant_price` remain the
Non-AC amounts. A blank service-price cell clears the override; omitting a column
preserves the saved override, so older CSV files continue to work. The import
revision includes all service prices and prevents applying a stale preview.
