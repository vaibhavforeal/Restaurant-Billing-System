import type { Database, IntegrationDef, LicenseStatus } from "@forkflow/domain";
import { httpError } from "./http-error.js";
import { integrationEnabled } from "./integrations.js";

type Features = LicenseStatus["features"];

// Licence features belong to the installation, not the requesting device, so code that only has the database
// (for example order mappers) can still ask whether a feature is licensed. buildServer registers the lookup.
const licensedFeatures = new WeakMap<Database, () => Features>();

export function provideLicensedFeatures(db: Database, features: () => Features): void {
  licensedFeatures.set(db, features);
}

/** True when the integration needs no licence feature, or the installation's plan includes it. Fails closed without a lookup. */
export function integrationLicensed(db: Database, def: IntegrationDef): boolean {
  if (!def.feature) return true;
  return licensedFeatures.get(db)?.()[def.feature] === true;
}

/** The Kitchen Display works only when the plan includes it and an admin has switched it on in the Marketplace. */
export function kdsActive(db: Database): boolean {
  return licensedFeatures.get(db)?.().kds === true && integrationEnabled(db, "kds");
}

export function assertKdsActive(db: Database): void {
  if (!kdsActive(db)) throw httpError(403, "Kitchen Display is turned off", "kds_off");
}
