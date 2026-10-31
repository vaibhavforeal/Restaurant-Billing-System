import { z } from "zod";
import type { D1Like } from "../env.js";
import type { PortalSettingsData } from "./api-types.js";
import { logBy, path, type Route } from "./context.js";
import { json, readBody } from "./http.js";
import { GST_STATES, GSTIN_PATTERN } from "./shared.js";

const optional = (max: number) => z.string().trim().max(max).default("");
export const PortalSettings = z.object({
  /** MasalaPOS as the seller on every invoice. */
  seller: z.object({
    legalName: optional(120), gstin: z.string().trim().toUpperCase().refine((v) => v === "" || GSTIN_PATTERN.test(v), "Enter a 15-character GSTIN").default(""),
    address: optional(300), city: optional(80), stateCode: z.string().refine((v) => v === "" || v in GST_STATES, "Choose a state").default(""),
    pincode: z.string().trim().regex(/^(\d{6})?$/, "Enter a 6-digit PIN code").default(""), email: optional(254), phone: optional(20),
  }).default({ legalName: "", gstin: "", address: "", city: "", stateCode: "", pincode: "", email: "", phone: "" }),
  invoice: z.object({
    /** Invoice numbers read <prefix>/<financial year>/<number>, e.g. FF/26-27/000001; GST allows 16 characters in all. */
    prefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,4}$/, "Use 1 to 4 letters or digits").default("FF"),
    /** SAC 997331: licensing services for the right to use computer software. */
    sac: z.string().trim().regex(/^\d{4,8}$/, "Enter a 4 to 8 digit SAC").default("997331"),
    gstRateBp: z.number().int().min(0).max(2800).default(1800),
    bankDetails: optional(500), terms: optional(1000),
  }).default({ prefix: "FF", sac: "997331", gstRateBp: 1800, bankDetails: "", terms: "" }),
  /** Default prices per outlet, before GST. Orders start from these and staff may change them. */
  prices: z.array(z.object({ plan: z.enum(["basic", "pro"]), termMonths: z.number().int().min(1).max(60), pricePaise: z.number().int().min(0).max(100_000_000) }))
    .max(40).default([]),
  /** Each extra device beyond the plan's, per outlet, for the whole term. */
  extraDevicePaise: z.number().int().min(0).max(100_000_000).default(0),
  trialDays: z.number().int().min(1).max(30).default(7),
}).strict();
export type PortalSettings = z.infer<typeof PortalSettings>;
// The web app reads the settings as PortalSettingsData; this fails to compile if the two drift apart.
const sameShape: [PortalSettings, PortalSettingsData] extends [PortalSettingsData, PortalSettings] ? true : never = true;
void sameShape;

export async function loadSettings(db: D1Like): Promise<PortalSettings> {
  const row = await db.prepare(`SELECT data FROM portal_settings WHERE id = 1`).first<{ data: string }>();
  const parsed = PortalSettings.safeParse(row ? JSON.parse(row.data) : {});
  // Settings saved by an older portal keep working: anything that no longer fits falls back to the defaults.
  return parsed.success ? parsed.data : PortalSettings.parse({});
}

export const settingsRoutes: Route[] = [
  // Readable by all staff: orders need the price list and the seller's state for the GST preview.
  { method: "GET", path: path("/settings"), handler: async (ctx) => json({ settings: await loadSettings(ctx.deps.db) }) },
  { method: "PUT", path: path("/settings"), permission: "settings.manage", handler: async (ctx) => {
    const settings = await readBody(ctx.request, PortalSettings);
    const { db } = ctx.deps, now = ctx.deps.now();
    await db.batch([
      db.prepare(`INSERT INTO portal_settings (id, data, updated_at, updated_by) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
        .bind(JSON.stringify(settings), now, ctx.user.id),
      logBy(ctx, { action: "settings.changed", entityType: "settings", entityId: "portal", customerId: null, summary: "Changed the portal settings" }),
    ]);
    return json({ settings });
  } },
];
