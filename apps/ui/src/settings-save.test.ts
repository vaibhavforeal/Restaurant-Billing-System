import { describe, expect, it } from "vitest";
import { settingsForSave } from "./settings-save";
import type { SettingsData } from "./types";

const FULL = { restaurantName: "Spice Hub", address: "1 MG Road", city: "Pune", stateCode: "27", pincode: "411001", phone: "9876543210", gstin: "", fssai: "123", receiptHeader: "Pure veg", receiptFooter: "Thanks", upiId: "", receiptStyle: "classic", gstMode: "included", gstRate: 5, kotEditPrint: "ask", holdOrdersEnabled: true, popularItemsEnabled: true, popularByTimeEnabled: true, orderedTogetherEnabled: true, customerUsualEnabled: true, sacCode: "996331", zomatoGstin: "", billShowFssai: true, billShowCustomer: true, billShowTable: true, billShowServedBy: false, billShowItemGst: false, invoicePrefix: "", roundOff: "rupee" } as SettingsData;

describe("settingsForSave", () => {
  it("drops blank city, state, PIN code and phone", () => {
    const body = settingsForSave({ ...FULL, city: " ", stateCode: "", pincode: "", phone: "  " });
    for (const key of ["city", "stateCode", "pincode", "phone"]) expect(body).not.toHaveProperty(key);
  });

  it("keeps every other key, including blanks and booleans", () => {
    const body = settingsForSave({ ...FULL, city: "", gstin: "", billShowServedBy: false });
    const { city: _city, ...rest } = FULL;
    expect(body).toEqual(rest);
  });
});
