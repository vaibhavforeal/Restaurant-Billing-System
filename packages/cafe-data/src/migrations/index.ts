import type { Migration } from "../migrate.js";
import { initial } from "./001-initial.js";

export const MIGRATIONS: readonly Migration[] = [initial];
