import type { Migration } from "../migrate.js";
import { baseline } from "./baseline.js";
import { dashboardLayouts } from "./dashboard-layouts.js";
import { holdOrders } from "./hold-orders.js";
import { popularItems } from "./popular-items.js";
import { orderedTogether } from "./ordered-together.js";
import { popularByTime } from "./popular-by-time.js";

/** Every schema change, in order. The baseline holds versions 1 to 43; new migrations number from 49. */
export const MIGRATIONS: Migration[] = [baseline, dashboardLayouts, holdOrders, popularItems, orderedTogether, popularByTime];
