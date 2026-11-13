import type { Migration } from "../migrate.js";
import { initial } from "./001-initial.js";
import { localState } from "./002-local-state.js";
import { errorLog } from "./003-error-log.js";
import { counter } from "./004-counter.js";

export const MIGRATIONS: readonly Migration[] = [initial, localState, errorLog, counter];
