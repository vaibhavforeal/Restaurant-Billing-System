import { describe, expect, it } from "vitest";
import { freshAppWithFakeSink, setupAdmin } from "./test-helpers.js";
import { seedDemo } from "./demo-seed.js";

describe("customer demo data", () => {
  it("creates useful sample workflows once and retains demo edits on restart", async () => {
    const { app } = freshAppWithFakeSink();
    try {
      await seedDemo(app);
      expect(app.db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 4 });
      expect(app.db.prepare("SELECT COUNT(*) AS n FROM products").get()).toEqual({ n: 14 });
      expect(app.db.prepare("SELECT COUNT(*) AS n FROM bills WHERE status = 'paid'").get()).toEqual({ n: 8 });
      expect(app.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'open'").get()).toEqual({ n: 3 });
      expect(app.db.prepare("SELECT COUNT(*) AS n FROM kots WHERE done_at IS NULL").get()).toEqual({ n: 3 });
      expect(app.db.prepare("SELECT enabled FROM integration_state WHERE id = 'kds'").get()).toEqual({ enabled: 1 });
      expect(app.db.prepare("SELECT COUNT(*) AS n FROM product_stock_links").get()).toEqual({ n: 12 });
      app.db.prepare("UPDATE users SET name = 'Customer demo edit' WHERE role = 'admin'").run();
      await seedDemo(app);
      expect(app.db.prepare("SELECT name FROM users WHERE role = 'admin'").get()).toEqual({ name: "Customer demo edit" });
      expect(app.db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(app.db.pragma("foreign_key_check")).toEqual([]);
    } finally { await app.close(); app.db.close(); }
  });
  it("refuses to seed over existing restaurant data", async () => {
    const { app } = freshAppWithFakeSink();
    try {
      await setupAdmin(app);
      await expect(seedDemo(app)).rejects.toThrow("existing restaurant");
      expect(app.db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
    } finally { await app.close(); app.db.close(); }
  });
});
