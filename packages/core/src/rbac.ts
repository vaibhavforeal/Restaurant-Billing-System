export interface RoleLimits {
  /** Largest discount this role may apply, in percent. */
  max_discount_percent?: number;
}

export interface Role {
  name: string;
  /** Permission slugs. Supports `namespace.*` and the full `*`. */
  permissions: string[];
  limits?: RoleLimits;
}

const FULL_ACCESS = "*";

/**
 * Does this role hold a permission?
 *
 * Fails closed: anything not explicitly granted is denied, so a permission
 * added later is unavailable until someone grants it, rather than silently
 * open to every existing role. Enforced identically on terminal and cloud —
 * a till that is offline is still a till that cannot void a bill.
 */
export function can(role: Role, permission: string): boolean {
  if (permission === "") return false;

  const namespace = permission.split(".")[0];
  return role.permissions.some(
    (granted) =>
      granted === FULL_ACCESS || granted === permission || granted === `${namespace}.${FULL_ACCESS}`,
  );
}

/**
 * Is a discount within what this role may authorise?
 *
 * An unset cap means zero, not unlimited — the common misconfiguration should
 * block a giveaway rather than permit one.
 */
export function withinDiscountCap(role: Role, percent: number): boolean {
  if (role.permissions.includes(FULL_ACCESS)) return true;
  return percent <= (role.limits?.max_discount_percent ?? 0);
}
