import type { Migration } from "../migrate.js";
import { migration001 } from "./001-initial.js";

export const MIGRATIONS: Migration[] = [migration001];
