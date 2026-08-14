import type { Migration } from "../migrate.js";
import { migration001 } from "./001-initial.js";
import { migration002 } from "./002-kot-done-and-item-refs.js";

export const MIGRATIONS: Migration[] = [migration001, migration002];
