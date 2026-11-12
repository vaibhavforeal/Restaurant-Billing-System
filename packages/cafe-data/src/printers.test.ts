import { describe, expect, it } from "vitest";
import { deletePrinter, listPrinters, printerFor, printTarget, savePrinter } from "./printers.js";
import { memoryCafeDb } from "./testing/sqlite-driver.js";

describe("printers", () => {
  it("keeps one printer per role and builds its target", () => {
    const db = memoryCafeDb();
    savePrinter(db, { name: "Counter BT", transport: "bluetooth", address: "00:11:22:33:44:55", paperWidth: 58, role: "receipt" });
    const network = savePrinter(db, { name: "Counter LAN", transport: "network", address: "192.168.1.50", paperWidth: 80, role: "receipt" });
    expect(listPrinters(db)).toHaveLength(1);
    expect(printerFor(db, "receipt")).toMatchObject({ id: network.id, name: "Counter LAN", paperWidth: 80, profile: { copies: 1, feedLines: 3, autoCut: true } });
    expect(printTarget(network)).toEqual({ transport: "network", host: "192.168.1.50", port: 9100 });
    expect(printTarget({ ...network, address: "192.168.1.50:9101" })).toEqual({ transport: "network", host: "192.168.1.50", port: 9101 });
    expect(printTarget({ ...network, transport: "bluetooth", address: "00:11:22:33:44:55" })).toEqual({ transport: "bluetooth", address: "00:11:22:33:44:55" });
    expect(printerFor(db, "kitchen")).toBeNull();
  });

  it("refuses a network address that is not a host and port, and deletes a printer", () => {
    const db = memoryCafeDb();
    expect(() => savePrinter(db, { name: "Bad", transport: "network", address: "http://x/y", paperWidth: 80, role: "receipt" })).toThrow();
    const p = savePrinter(db, { name: "BT", transport: "bluetooth", address: "AA:BB:CC:DD:EE:FF", paperWidth: 58, role: "receipt", profile: { copies: 2, feedLines: 4, autoCut: false } });
    expect(printerFor(db, "receipt")!.profile).toEqual({ copies: 2, feedLines: 4, autoCut: false });
    deletePrinter(db, p.id);
    expect(listPrinters(db)).toEqual([]);
  });
});
