import type { Migration } from "../migrate.js";
import { baseline } from "./baseline.js";
import { dashboardLayouts } from "./dashboard-layouts.js";

/** Every schema change, in order. The baseline holds versions 1 to 43; add new migrations after it, numbered from 45. */
export const MIGRATIONS: Migration[] = [baseline, dashboardLayouts];
