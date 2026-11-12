import { uuidv7 } from "@masalapos/domain/id";
import { networkPrinterAddress, PrintProfile, type PrintProfileInput } from "@masalapos/domain/printer-schemas";
import type { SqlDriver } from "./driver.js";
import { dataChanged } from "./events.js";

/** Where the printer module sends bytes. */
export type PrintTarget = { transport: "bluetooth"; address: string } | { transport: "network"; host: string; port: number };

export interface Printer {
  id: string; name: string; transport: "bluetooth" | "network";
  /** A Bluetooth MAC address, or a network "host" or "host:port". */
  address: string;
  paperWidth: 58 | 80; role: "receipt" | "kitchen"; profile: PrintProfileInput;
}

interface PrinterRow { id: string; name: string; transport: Printer["transport"]; address: string; paper_width: 58 | 80; role: Printer["role"]; profile_json: string }

const toPrinter = (r: PrinterRow): Printer => ({
  id: r.id, name: r.name, transport: r.transport, address: r.address, paperWidth: r.paper_width, role: r.role, profile: PrintProfile.parse(JSON.parse(r.profile_json)),
});

export function listPrinters(db: SqlDriver): Printer[] {
  return db.all<PrinterRow>("SELECT * FROM printers ORDER BY role, name").map(toPrinter);
}

/** Saves the printer for its role; there is one printer per role, so saving replaces that role's printer. */
export function savePrinter(db: SqlDriver, input: Omit<Printer, "id" | "profile"> & { id?: string; profile?: PrintProfileInput }): Printer {
  const name = input.name.trim();
  if (!name) throw new Error("Give the printer a name");
  if (input.transport === "network") networkPrinterAddress(input.address.trim());
  else if (!input.address.trim()) throw new Error("Choose a paired printer");
  const printer: Printer = { id: input.id ?? uuidv7(), name, transport: input.transport, address: input.address.trim(), paperWidth: input.paperWidth,
    role: input.role, profile: PrintProfile.parse(input.profile ?? {}) };
  db.transaction(() => {
    db.run("DELETE FROM printers WHERE role = ? OR id = ?", [printer.role, printer.id]);
    db.run("INSERT INTO printers (id, name, transport, address, paper_width, role, profile_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [printer.id, printer.name, printer.transport, printer.address, printer.paperWidth, printer.role, JSON.stringify(printer.profile)]);
  });
  dataChanged();
  return printer;
}

export function deletePrinter(db: SqlDriver, id: string): void {
  db.transaction(() => db.run("DELETE FROM printers WHERE id = ?", [id]));
  dataChanged();
}

export function printerFor(db: SqlDriver, role: "receipt" | "kitchen"): Printer | null {
  const row = db.get<PrinterRow>("SELECT * FROM printers WHERE role = ?", [role]);
  return row ? toPrinter(row) : null;
}

/** A network address is "host" or "host:port", port 9100 by default. */
export function printTarget(p: Printer): PrintTarget {
  if (p.transport === "bluetooth") return { transport: "bluetooth", address: p.address };
  const { host, port } = networkPrinterAddress(p.address);
  return { transport: "network", host, port };
}
