import { addMonths, GRACE_MS } from "../dates.js";
import type { D1StatementLike } from "../env.js";
import { issueLicense, type Deps } from "../issue.js";
import type { LicensingOrder } from "../orders.js";
import { activityStatement, INSTALLATION_COLUMNS, latestLicense, setOverridesStatement, type InstallationRow } from "../store.js";

/**
 * Everything that happens when an order is paid in full, as statements for one batch with whatever paid it (a payment, a webhook, or
 * confirming an order worth nothing):
 * - the order becomes paid; the first statement fails the whole batch when the order is no longer waiting for payment, so an order is
 *   fulfilled once even when two payments land at the same moment;
 * - counters that activated on credit get the order's full term, counted from the day each activated;
 * - each counter a renewal order extends gets the order's plan, devices and modules until its current end date (or today, if it has
 *   lapsed) plus the term.
 */
export async function fulfilmentStatements(deps: Deps, order: LicensingOrder, actorId: string | null): Promise<D1StatementLike[]> {
  const { db } = deps, now = deps.now();
  const out: D1StatementLike[] = [
    // seats_used can never be negative, so this UPDATE breaks its CHECK, and the batch, unless the order is still 'confirmed'.
    db.prepare(`UPDATE orders SET seats_used = -1 WHERE id = ? AND status <> 'confirmed'`).bind(order.id),
    db.prepare(`UPDATE orders SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?`).bind(now, now, order.id),
  ];
  let renewed = 0;
  if (order.kind === "new") {
    const { results } = await db.prepare(`SELECT ${INSTALLATION_COLUMNS} FROM installations WHERE order_id = ?`).bind(order.id).all<InstallationRow>();
    for (const installation of results) {
      const latest = await latestLicense(db, installation.installationId);
      const full = addMonths(installation.activatedAt ?? now, order.termMonths!);
      if (!latest || latest.expiresAt >= full) continue;
      const { statement } = await issueLicense(deps, { installation, plan: order.plan, expiresAt: full, graceUntil: full + GRACE_MS, trial: false, reason: "order", orderId: order.id });
      out.push(statement);
      renewed++;
    }
  }
  if (order.kind === "renewal") {
    const { results } = await db.prepare(`SELECT ${INSTALLATION_COLUMNS} FROM installations
      WHERE installation_id IN (SELECT installation_id FROM order_installations WHERE order_id = ?)`).bind(order.id).all<InstallationRow>();
    for (const installation of results) {
      const latest = await latestLicense(db, installation.installationId);
      const expiresAt = addMonths(Math.max(latest?.expiresAt ?? now, now), order.termMonths!);
      const next = { ...installation, maxDevices: order.maxDevices };
      const { statement } = await issueLicense(deps, { installation: next, plan: order.plan, expiresAt, graceUntil: expiresAt + GRACE_MS, trial: false, reason: "order", orderId: order.id, modules: order.modules });
      out.push(
        db.prepare(`UPDATE installations SET max_devices = ? WHERE installation_id = ?`).bind(order.maxDevices, installation.installationId),
        setOverridesStatement(db, installation.installationId, order.modules, now),
        statement,
      );
      renewed++;
    }
  }
  out.push(activityStatement(db, now, {
    actorId, action: "order.paid", entityType: "order", entityId: order.id, customerId: order.customerId,
    summary: `Order ${order.code} is paid${renewed ? `; ${renewed === 1 ? "1 counter's licence" : `${renewed} counters' licences`} extended` : ""}`,
  }));
  return out;
}
