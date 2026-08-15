import type { Migration } from "../migrate.js";
import { migration001 } from "./001-initial.js";
import { migration002 } from "./002-kot-done-and-item-refs.js";
import { migration003 } from "./003-order-split-label.js";
import { migration004 } from "./004-printer-kinds.js";

export const MIGRATIONS: Migration[] = [migration001, migration002, migration003, migration004];
