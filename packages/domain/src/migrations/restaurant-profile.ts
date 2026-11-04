import type { Migration } from "../migrate.js";

/** Restaurant profile: first-run setup asks for the phone and a structured address (city, state, PIN code) alongside the street line. */
export const restaurantProfile: Migration = {
  version: 49,
  name: "restaurant_profile",
  up(db) {
    for (const column of ["phone", "city", "state_code", "pincode"]) db.exec(`ALTER TABLE settings ADD COLUMN ${column} TEXT NOT NULL DEFAULT '';`);
  },
};
