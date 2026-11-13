import Constants from "expo-constants";
import { logError, type SqlDriver } from "@masalapos/cafe-data";
import { deviceOffset } from "../dates";
import { errorText, formatErrorReport } from "./report";

/** When the tester last opened the error log; newer errors raise a banner on the Bill screen. */
export const ERRORS_SEEN_KEY = "errors.seenAt";

let db: SqlDriver | null = null;
let installed = false;

/** Records an error in the phone's error log, with where it happened. Safe to call from anywhere; never throws. */
export function recordError(e: unknown, context: string | null = null): void {
  if (!db) return;
  const { message, stack } = errorText(e);
  logError(db, { at: Date.now(), message, stack, context });
}

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;
interface ErrorUtilsLike { getGlobalHandler(): GlobalHandler; setGlobalHandler(handler: GlobalHandler): void }

/** From now on every uncaught JavaScript error is written to the log before React Native handles it (a crash still crashes). */
export function startErrorCapture(driver: SqlDriver): void {
  db = driver;
  const utils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  if (installed || !utils) return;
  installed = true;
  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((error, isFatal) => {
    recordError(error, isFatal ? "crash" : "uncaught");
    previous(error, isFatal);
  });
}

export const appVersion = () => Constants.expoConfig?.version ?? "unknown";

/** The report text for one error, for screens that show an error before the log can be read. */
export function singleErrorReport(e: unknown, context: string): string {
  const { message, stack } = errorText(e);
  return formatErrorReport([{ at: Date.now(), message, stack, context }], { appVersion: appVersion(), tzOffsetMinutes: deviceOffset() });
}
