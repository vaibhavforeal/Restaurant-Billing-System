import { expect, it } from "vitest";
import { catalogCommand, settingsCommand } from "./commands";

it("sends prices in paise with the original entity revision, never overwriting untouched fields", () => {
  const command = catalogCommand("products", { key: { id: "p1" }, revision: 23, row: { name: "Tea", price_paise: 1000, category_id: "c1", is_active: 1 } }, { name: "Masala tea", price: "15.50", active: true, description: "Spiced", veg: true, soldOut: false });
  expect(command).toEqual({ kind: "product.update", targetId: "p1", expectedRevision: 23, payload: { name: "Masala tea", pricePaise: 1550, isActive: true, description: "Spiced", isVeg: true, isSoldOut: false } });
});
it("preserves settings omitted from the visible editor", () => {
  const command = settingsCommand({ key: { id: 1 }, revision: 44, row: { restaurant_name: "Old", receipt_style: "classic", gst_mode: "unregistered", gst_rate: 5, upi_id: "old@bank" } }, { restaurantName: "New", address: "Road", gstin: "", fssai: "", receiptFooter: "Thanks", upiId: "new@bank" });
  expect(command.expectedRevision).toBe(44);
  expect(command.payload).toMatchObject({ restaurantName: "New", receiptStyle: "classic", gstMode: "unregistered", gstRate: 5, upiId: "new@bank" });
});
