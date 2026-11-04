import type { Migration } from "../migrate.js";
import { baseline } from "./baseline.js";
import { restaurantProfile } from "./restaurant-profile.js";

/** Every schema change, in order. The baseline holds versions 1 to 43; 44 to 46 are on other branches (Dynamic Reports, hold order, popular items). */
export const MIGRATIONS: Migration[] = [baseline, restaurantProfile];
