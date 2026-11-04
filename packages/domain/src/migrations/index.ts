import type { Migration } from "../migrate.js";
import { baseline } from "./baseline.js";
import { holdOrders } from "./hold-orders.js";
import { popularItems } from "./popular-items.js";
import { orderedTogether } from "./ordered-together.js";

/** Every schema change, in order. The baseline holds versions 1 to 43; 44 is Dynamic Reports' (on its own branch); new migrations number from 48. */
export const MIGRATIONS: Migration[] = [baseline, holdOrders, popularItems, orderedTogether];
