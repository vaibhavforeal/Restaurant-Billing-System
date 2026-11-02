import type { Migration } from "../migrate.js";
import { baseline } from "./baseline.js";

/** Every schema change, in order. The baseline holds versions 1 to 43; add new migrations after it, numbered from 44. */
export const MIGRATIONS: Migration[] = [baseline];
