import type { LicenseStatus } from "@forkflow/domain";

const FEATURE_LABELS: Record<keyof LicenseStatus["features"], string> = { recipes: "Recipe editing", qrOrdering: "QR ordering", kds: "Kitchen Display" };

/** One line naming every paid feature and whether a licence includes it, e.g. for the active plan or a licence preview. */
export function featureSummary(features: LicenseStatus["features"]): string {
  return (Object.keys(FEATURE_LABELS) as Array<keyof typeof FEATURE_LABELS>)
    .map((feature) => `${FEATURE_LABELS[feature]}: ${features[feature] ? "included" : "not included"}.`).join(" ");
}
