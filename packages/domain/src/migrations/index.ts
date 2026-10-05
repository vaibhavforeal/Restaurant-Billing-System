import type { Migration } from "../migrate.js";
import { migration001 } from "./001-initial.js";
import { migration002 } from "./002-kot-done-and-item-refs.js";
import { migration003 } from "./003-order-split-label.js";
import { migration004 } from "./004-printer-kinds.js";
import { migration005 } from "./005-billing-snapshots.js";
import { migration006 } from "./006-inventory-ledger.js";
import { migration007 } from "./007-kot-requests.js";
import { migration023 } from "./023-stock-costing.js";

export const MIGRATIONS: Migration[] = [migration001, migration002, migration003, migration004, migration005, migration006, migration007, migration023];
