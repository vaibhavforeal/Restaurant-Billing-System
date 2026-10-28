import type { Database } from "@forkflow/domain";
import { httpError } from "./http-error.js";
import { moduleActive } from "./modules.js";

/** The Kitchen Display works only when the ForkFlow owner allows it and an admin has switched it on in the Marketplace. */
export function kdsActive(db: Database): boolean {
  return moduleActive(db, "kds");
}

export function assertKdsActive(db: Database): void {
  if (!kdsActive(db)) throw httpError(403, "Kitchen Display is turned off", "kds_off");
}
