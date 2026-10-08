import { ApiError } from "./api";

/** The server refuses kitchen routes with this code while the Kitchen Display is switched off or not in the plan. */
export function isKdsOff(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && error.code === "kds_off";
}
