import { DEFAULT_BILL_SHOW, calculateBill, financialYear, formatInvoiceNo, formatRestaurantAddress, type Bill, type BillShow, type SettingsUpdateInput } from "@masalapos/domain";

type PreviewSettings = SettingsUpdateInput & { stateCode: string; city: string; pincode: string; phone: string };

const ITEMS = [
  { name: "Paneer Tikka", pricePaise: 28000, qty: 1, gstRate: 5 },
  { name: "Fresh Lime Soda", pricePaise: 9013, qty: 2, gstRate: 18 },
];

/** A fixed unpaid sample bill dressed in the (possibly unsaved) Bill settings, so the form can show what a printed bill will look like. */
export function sampleBill(s: PreviewSettings): Bill {
  const gstMode = s.gstMode ?? "included";
  const billShow: BillShow = {
    fssai: s.billShowFssai ?? DEFAULT_BILL_SHOW.fssai, customer: s.billShowCustomer ?? DEFAULT_BILL_SHOW.customer,
    table: s.billShowTable ?? DEFAULT_BILL_SHOW.table, servedBy: s.billShowServedBy ?? DEFAULT_BILL_SHOW.servedBy,
    itemGst: s.billShowItemGst ?? DEFAULT_BILL_SHOW.itemGst,
  };
  const createdAt = new Date(2026, 3, 1, 13, 30).getTime();
  return {
    ...calculateBill(ITEMS, 0, gstMode, s.roundOff ?? "rupee"),
    id: "preview", billNo: 1, invoiceNo: formatInvoiceNo(s.invoicePrefix ?? "", financialYear(createdAt).short, 1), orderId: "preview", status: "unpaid", discountNote: null,
    createdAt,
    receipt: {
      gstMode, restaurantName: s.restaurantName, address: formatRestaurantAddress({ address: s.address, city: s.city, stateCode: s.stateCode, pincode: s.pincode }),
      phone: s.phone, gstin: s.gstin, fssai: s.fssai, receiptHeader: s.receiptHeader, receiptFooter: s.receiptFooter, billShow,
      ...(s.upiId !== undefined ? { upiId: s.upiId } : {}), ...(s.receiptStyle !== undefined ? { receiptStyle: s.receiptStyle } : {}),
      orderType: "dine_in", tableName: "T4", splitLabel: null,
      customer: { name: "Asha", phone: "******3210" }, servedBy: "Ravi", items: ITEMS,
    },
    payments: [], refundState: "none", creditNotes: [], refundedQty: {},
  };
}
