import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { uuidv7 } from "@forkflow/domain";
import { auth, freshApp, setupAdmin } from "../apps/server/src/test-helpers.js";

describe("read-only credit history diagnostic", () => {
  let directory: string, template: string, path: string;
  let billId: string, orderItemId: string, adminId: string;
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "forkflow-credit-audit-"));
    template = join(directory, "template.db");
    const app = freshApp();
    try {
      const admin = await setupAdmin(app);
      adminId = admin.user.id;
      const headers = auth(admin.token);
      const category = await app.inject({ method: "POST", url: "/api/categories", headers, payload: { name: "Food" } });
      const product = await app.inject({ method: "POST", url: "/api/products", headers,
        payload: { name: "Dish", categoryId: category.json().category.id, pricePaise: 1000, gstRate: 18 } });
      const order = await app.inject({ method: "POST", url: "/api/orders", headers, payload: { clientRef: uuidv7(), type: "parcel" } });
      const orderId = order.json().order.id;
      expect((await app.inject({ method: "POST", url: `/api/orders/${orderId}/items`, headers,
        payload: { items: [{ productId: product.json().product.id, qty: 10, clientRef: uuidv7() }] } })).statusCode).toBe(200);
      const discount = { discountPaise: 9935, discountNote: "Test" };
      const preview = await app.inject({ method: "POST", url: `/api/orders/${orderId}/bill-preview`, headers, payload: discount });
      const issued = await app.inject({ method: "POST", url: `/api/orders/${orderId}/bill`, headers,
        payload: { ...discount, clientRef: uuidv7(), previewKey: preview.json().preview.previewKey } });
      expect(issued.statusCode, issued.body).toBe(201);
      billId = issued.json().bill.id;
      orderItemId = (app.db.prepare("SELECT order_item_id AS id FROM bill_report_lines WHERE bill_id = ?").get(billId) as { id: string }).id;
      expect((await app.inject({ method: "POST", url: `/api/bills/${billId}/settle`, headers,
        payload: { clientRef: uuidv7(), payments: [{ mode: "cash", amountPaise: 100, refNote: "secret-payment-reference" }] } })).statusCode).toBe(200);
      await app.db.backup(template);
    } finally { await app.close(); app.db.close(); }
  });
  beforeEach(() => {
    path = join(directory, `${uuidv7()}.db`);
    copyFileSync(template, path);
  });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  function credit(qty: number, amounts: [number, number, number, number, number], options: { refund?: number; noteAmounts?: typeof amounts; mode?: string; kind?: string } = {}) {
    const db = new Database(path);
    try {
      const id = uuidv7();
      db.prepare(`INSERT INTO credit_notes (id, cn_no, bill_id, kind, reason, taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise,
        requested_by, approved_by, created_at, client_ref, request_json) VALUES (?, (SELECT COUNT(*) + 1 FROM credit_notes), ?, ?, 'Test', ?, ?, ?, ?, ?, ?, ?, 1, ?, '{}')`)
        .run(id, billId, options.kind ?? "refund", ...(options.noteAmounts ?? amounts), adminId, adminId, uuidv7());
      db.prepare(`INSERT INTO credit_note_lines (credit_note_id, order_item_id, name, category_name, gst_rate, qty,
        taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise) VALUES (?, ?, 'Dish', 'Food', 18, ?, ?, ?, ?, ?, ?)`)
        .run(id, orderItemId, qty, ...amounts);
      db.prepare("INSERT INTO credit_note_taxes (credit_note_id, gst_rate, taxable_paise, cgst_paise, sgst_paise) VALUES (?, 18, ?, ?, ?)").run(id, ...amounts.slice(0, 3));
      const refund = options.refund ?? amounts[4];
      if (refund > 0) db.prepare("INSERT INTO refund_payments (id, credit_note_id, mode, amount_paise, ref_note, created_at) VALUES (?, ?, ?, ?, 'secret-refund-reference', 1)")
        .run(uuidv7(), id, options.mode ?? "cash", refund);
      if (options.kind === "void") db.prepare("UPDATE bills SET status = 'void' WHERE id = ?").run(billId);
      return id;
    } finally { db.close(); }
  }

  function run(args: string[] = [path]) {
    return spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./audit-credit-history.mts", import.meta.url)), ...args],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" });
  }
  function check(expectedStatus: number) {
    const before = readFileSync(path), filesBefore = readdirSync(directory);
    const result = run();
    expect(result.status, result.stderr || result.stdout).toBe(expectedStatus);
    const output = JSON.parse(result.stdout) as { billsChecked: number; findings: Array<{ billId: string; orderItemId?: string; creditNoteId?: string; invariant: string; field?: string }> };
    expect(output.billsChecked).toBe(1);
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(directory)).toEqual(filesBefore);
    expect(result.stdout).not.toMatch(/secret-payment-reference|secret-refund-reference|pin_hash|request_json/);
    return output.findings;
  }

  it("returns exit 0 and no findings for a clean backup without changing its bytes or adjacent files", () => {
    expect(check(0)).toEqual([]);
  });
  it("does not create sidecars for a stopped WAL-mode backup", () => {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.close();
    expect(readFileSync(path)[18]).toBe(2);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(check(0)).toEqual([]);
  });
  it("refuses a backup with an outstanding WAL instead of inspecting stale main-file data", () => {
    const db = new Database(path);
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("wal_autocheckpoint = 0");
      db.exec("CREATE TABLE committed_in_wal (value TEXT)");
      const filesBefore = readdirSync(directory);
      const bytes = [path, `${path}-wal`, `${path}-shm`].map((file) => readFileSync(file));
      const result = run();
      expect(result.status, result.stderr || result.stdout).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ error: expect.any(String) });
      expect(readdirSync(directory)).toEqual(filesBefore);
      for (const [index, file] of [path, `${path}-wal`, `${path}-shm`].entries()) {
        expect(readFileSync(file)).toEqual(bytes[index]);
      }
    } finally { db.close(); }
  });
  it("accepts recoverable older credits ahead of the cumulative schedule", () => {
    credit(4, [36, 5, 5, 26, 72]);
    expect(check(0)).toEqual([]);
  });
  it("reports over-credited GST with bill and line identifiers", () => {
    credit(8, [48, 8, 8, 32, 96]);
    expect(check(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ billId, orderItemId, invariant: "credited_amount_out_of_bounds", field: "cgstPaise" }),
      expect.objectContaining({ billId, orderItemId, invariant: "credited_amount_out_of_bounds", field: "sgstPaise" }),
    ]));
  });
  it("checks already finalized bills with unexplained money remaining", () => {
    credit(10, [54, 5, 5, 35, 99], { kind: "void" });
    expect(check(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ billId, orderItemId, invariant: "fully_credited_quantity_has_money_remaining", field: "totalPaise" }),
    ]));
  });
  it("detects negative individual tax even when a later credit makes the final cumulative amounts exact", () => {
    credit(8, [48, 8, 8, 32, 96]);
    const creditNoteId = credit(2, [7, -3, -3, 3, 4], { kind: "void" });
    expect(check(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ billId, orderItemId, creditNoteId, invariant: "negative_saved_amount", field: "cgstPaise" }),
    ]));
  });
  it("reports note/line discrepancies and refund payments exceeding the original payment", () => {
    const creditNoteId = credit(1, [6, 1, 1, 2, 10], { noteAmounts: [6, 1, 1, 3, 11], refund: 101 });
    expect(check(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ billId, creditNoteId, invariant: "note_lines_do_not_sum", field: "totalPaise" }),
      expect.objectContaining({ billId, invariant: "refunds_exceed_payments" }),
    ]));
  });
  it("reports refunds exceeding a payment mode even when the overall total fits", () => {
    credit(1, [6, 1, 1, 2, 10], { mode: "upi" });
    expect(check(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ billId, invariant: "refunds_exceed_payments_by_mode" }),
    ]));
  });
  it("reports fractional saved quantities and negative total amounts", () => {
    const creditNoteId = credit(0.5, [0, 0, 0, -1, -1]);
    expect(check(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ billId, orderItemId, creditNoteId, invariant: "nonintegral_saved_quantity" }),
      expect.objectContaining({ billId, orderItemId, creditNoteId, invariant: "negative_saved_amount", field: "totalPaise" }),
    ]));
  });
  it("requires an explicit existing database and uses exit 2 for execution errors", () => {
    const missing = join(directory, "missing.db");
    for (const args of [[], [missing], [path, "extra"], [":memory:"]]) {
      const result = run(args);
      expect(result.status, result.stderr || result.stdout).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ error: expect.any(String) });
    }
    expect(existsSync(missing)).toBe(false);
  });
  it("does not migrate or otherwise alter an existing database with an unsupported schema", () => {
    const unsupported = join(directory, "unsupported.db");
    const db = new Database(unsupported);
    db.exec("CREATE TABLE original_marker (value TEXT)");
    db.close();
    const before = readFileSync(unsupported);
    const result = run([unsupported]);
    expect(result.status, result.stderr || result.stdout).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: expect.any(String) });
    expect(readFileSync(unsupported)).toEqual(before);
  });
  it("rejects an empty partial schema rather than reporting a clean audit", () => {
    const unsupported = join(directory, "partial.db");
    const db = new Database(unsupported);
    db.exec("CREATE TABLE bills (id TEXT PRIMARY KEY)");
    db.close();
    const before = readFileSync(unsupported), filesBefore = readdirSync(directory);
    const result = run([unsupported]);
    expect(result.status, result.stderr || result.stdout).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: expect.any(String) });
    expect(readFileSync(unsupported)).toEqual(before);
    expect(readdirSync(directory)).toEqual(filesBefore);
  });
});
