import { expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

it("upgrades old bills without changing money or inventing historical categories or cancellation dates", () => {
  const db = openDb(":memory:");
  try {
    migrate(db, MIGRATIONS.filter((m) => m.version < 17));
    db.exec(`INSERT INTO categories (id,name) VALUES ('c','Current category');
      INSERT INTO users (id,name,pin_hash,role,created_at) VALUES ('u','Staff','hash','admin',0);
      INSERT INTO products (id,category_id,name,price_paise,gst_rate,created_at) VALUES ('p','c','New name',50000,5,0);
      INSERT INTO orders (id,client_ref,type,status,opened_by,opened_at) VALUES ('o','legacy-order','parcel','billed','u',0);
      INSERT INTO order_items (id,order_id,product_id,name_snapshot,price_paise_snapshot,gst_rate_snapshot,qty,status) VALUES ('i','o','p','Old name',10001,5,1,'sent');
      INSERT INTO bills (id,bill_no,order_id,subtotal_paise,discount_paise,cgst_paise,sgst_paise,rounding_paise,total_paise,created_at,created_by) VALUES ('b',1,'o',10001,1,250,250,0,10500,0,'u');
      INSERT INTO bill_taxes (id,bill_id,gst_rate,taxable_paise,cgst_paise,sgst_paise) VALUES ('tx','b',5,10000,250,250);`);
    const before = db.prepare("SELECT * FROM bills").all();
    migrate(db, MIGRATIONS); migrate(db, MIGRATIONS);
    expect(db.prepare("SELECT * FROM bills").all()).toEqual(before);
    expect(db.prepare("SELECT name, category_name, total_paise, discount_paise FROM bill_report_lines").get()).toEqual({ name: "Old name", category_name: "Historical category unavailable", total_paise: 10500, discount_paise: 1 });
    expect(db.prepare("SELECT cancelled_at FROM order_items").get()).toEqual({ cancelled_at: null });
  } finally { db.close(); }
});
