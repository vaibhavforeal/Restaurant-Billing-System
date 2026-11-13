export type { SqlDriver } from "./driver.js";
export { migrate, type Migration } from "./migrate.js";
export { MIGRATIONS } from "./migrations/index.js";
export { nextSequence } from "./sequences.js";
export { businessDate, cafeFinancialYear } from "./time.js";
export { onDataChanged, dataChanged } from "./events.js";
export {
  CafeSettingsInput, getCafe, saveCafe, getDevice, type CafeSettings, type Device,
} from "./cafe.js";
export {
  MenuError, listMenu, saveCategory, deleteCategory, saveItem, setItemAvailable, deleteItem, moveInList, seedSampleMenu,
  type Category, type Variant, type Item, type ItemInput,
} from "./menu.js";
export {
  BillError, previewBill, createBill, getBill, listBills, lastBillAt,
  type BillErrorCode, type CartLine, type PaymentInput, type CreateBillInput, type CafeBill,
} from "./bills.js";
export { voidBill } from "./bills.js";
export { daySummary, type DaySummary } from "./reports.js";
export { listPrinters, savePrinter, deletePrinter, printerFor, printTarget, type Printer, type PrintTarget } from "./printers.js";
export { PIN_HASH_ITERATIONS, isValidPin, hashPin, verifyPin } from "./pin-hash.js";
export { CAFE_ROLES, cafeCan, discountAllowed, type CafeRole, type CafePermission } from "./roles.js";
export {
  StaffError, listStaff, getStaff, staffPinHash, addStaff, updateStaff, setStaffPinHash, hasActiveOwner,
  type Staff, type StaffErrorCode,
} from "./staff.js";
export {
  CounterSettingsInput, LOCK_MINUTES, getCounterSettings, saveCounterSettings, type CounterSettings,
} from "./counter-settings.js";
export { getLocalState, setLocalState } from "./local-state.js";
export { logError, listErrors, clearErrors, type ErrorEntry } from "./error-log.js";
