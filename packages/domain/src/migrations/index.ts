import type { Migration } from "../migrate.js";
import { baseline } from "./baseline.js";
import { dashboardLayouts } from "./dashboard-layouts.js";
import { holdOrders } from "./hold-orders.js";
import { popularItems } from "./popular-items.js";
import { orderedTogether } from "./ordered-together.js";
import { popularByTime } from "./popular-by-time.js";
import { restaurantProfile } from "./restaurant-profile.js";
import { passwordLogin } from "./password-login.js";
import { customerUsual } from "./customer-usual.js";
import { activityAlerts } from "./activity-alerts.js";
import { gstReturns } from "./gst-returns.js";
import { orderSummary } from "./order-summary.js";
import { itemTransfers } from "./item-transfers.js";
import { billSettings } from "./bill-settings.js";
import { invoiceNumbering } from "./invoice-numbering.js";

/** Every schema change, in order. The baseline holds versions 1 to 43; new migrations number from 54. */
export const MIGRATIONS: Migration[] = [baseline, dashboardLayouts, holdOrders, popularItems, orderedTogether, popularByTime, restaurantProfile, passwordLogin, customerUsual, activityAlerts, gstReturns, orderSummary, itemTransfers, billSettings, invoiceNumbering];
