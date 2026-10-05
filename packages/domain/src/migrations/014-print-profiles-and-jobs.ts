import type { Migration } from "../migrate.js";

export const migration014: Migration = {
  version: 14, name: "print-profiles-and-jobs",
  up(db) {
    db.exec(`
      ALTER TABLE printers ADD COLUMN receipt_profile TEXT NOT NULL DEFAULT '{"copies":1,"feedLines":3,"autoCut":true}';
      ALTER TABLE printers ADD COLUMN kot_profile TEXT NOT NULL DEFAULT '{"copies":1,"feedLines":3,"autoCut":true}';
      CREATE TABLE print_jobs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        printer_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','printing','done','failed','unknown')),
        job_json TEXT NOT NULL,
        target_json TEXT NOT NULL,
        payload BLOB NOT NULL
      );
      CREATE INDEX print_jobs_pending ON print_jobs(printer_id, status, sequence);
      CREATE TABLE print_queue_state (id INTEGER PRIMARY KEY CHECK(id = 1), generation TEXT NOT NULL);
    `);
  },
};
