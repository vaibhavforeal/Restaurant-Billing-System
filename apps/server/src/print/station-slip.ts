import type { FastifyInstance } from "fastify";
import { bestEffortPrint } from "./best-effort.js";
import { readProfile, contextLine } from "@masalapos/print";
import { kdsActive } from "../kds.js";

/** What a station slip's template needs to know about where it prints. */
export interface StationTarget {
  stationName: string;
  paperWidth: 58 | 80;
  profile: ReturnType<typeof readProfile>;
}

/**
 * Renders a kitchen slip (a KOT, a cancel, an edit or a table change) for a station's printer and queues it there. `queued` says
 * whether it was. `error` says why it was saved but not printed, for the screen to show (the station is gone or turned off, its
 * printer is turned off, or the slip could not be rendered); it is null when queued, and for a station with no printer at all (a
 * screen-only station, which is a valid setup), and while the Kitchen Display is on with Settings set not to print alongside it. Queueing is not wrapped: a failed insert aborts the caller's transaction, so no ticket is saved without
 * its print job.
 */
export function printStationSlip(app: FastifyInstance, stationId: string, kind: "kot" | "cancel" | "edit" | "table", label: string,
  render: (target: StationTarget) => Uint8Array): { queued: boolean; error: string | null } {
  if (!kitchenSlipsPrint(app)) return { queued: false, error: null };
  const station = app.db.prepare("SELECT name, printer_id, is_active FROM kot_stations WHERE id = ?").get(stationId) as
    { name: string; printer_id: string | null; is_active: number } | undefined;
  const fail = (error: string) => ({ queued: false, error });
  if (!station) return fail(`${label} was saved but not printed: its kitchen station no longer exists`);
  if (!station.printer_id) return { queued: false, error: null };
  if (station.is_active !== 1) return fail(`${label} was saved but not printed: the ${station.name} station is turned off`);
  const printer = app.db.prepare("SELECT id, name, kind, connection, is_active, paper_width, kot_profile FROM printers WHERE id = ?").get(station.printer_id) as
    { id: string; name: string; kind: "network" | "windows" | "bluetooth"; connection: string; is_active: number; paper_width: number; kot_profile: string } | undefined;
  if (!printer || printer.is_active !== 1) return fail(`${label} was saved but not printed: the ${station.name} station's printer is turned off`);
  // A bad profile is a configuration fault like a template error: reported, never thrown into the ticket's transaction.
  let copies = 1;
  const rendered = bestEffortPrint(app.log, label, () => {
    const profile = readProfile(printer.kot_profile);
    copies = profile.copies;
    return render({ stationName: station.name, paperWidth: printer.paper_width as 58 | 80, profile });
  });
  if (rendered.error) return fail(rendered.error);
  app.printQueue.enqueue(printer, kind, label, rendered.value!, copies);
  return { queued: true, error: null };
}

/** Kitchen slips print unless the Kitchen Display is on and Settings → Bill settings says the screens are enough. */
function kitchenSlipsPrint(app: FastifyInstance): boolean {
  const { v } = app.db.prepare("SELECT kot_print_with_kds AS v FROM settings WHERE id = 1").get() as { v: number };
  return v === 1 || !kdsActive(app.db);
}

/** The order as print-job labels name it on the print queue screen: the slip's context line, but "Zomato #id" rather than the slip's capitals. */
export function jobContext(order: { type: "dine_in" | "parcel" | "zomato"; split_label: string | null; zomato_order_id?: string | null; order_type_name?: string | null },
  tableName: string | null): string {
  return order.type === "zomato" ? `Zomato #${order.zomato_order_id ?? ""}`
    : contextLine(order.type, tableName, order.split_label, null, order.order_type_name ?? null);
}
