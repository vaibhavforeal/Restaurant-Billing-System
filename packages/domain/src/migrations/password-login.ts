import type { Migration } from "../migrate.js";

/** "Asha K." becomes "ashak": a sign-in name made from a person's name, at least 3 characters and unique among `taken`. */
export function usernameFromName(name: string, taken: Set<string>): string {
  let base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "").slice(0, 28);
  if (base.length < 3) base = `${base}user`.slice(0, 28);
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}${n}`;
  taken.add(candidate);
  return candidate;
}

/**
 * Password sign-in: everyone signs in with a username and password, and only admins keep a PIN, for approving at the counter.
 * People already on the counter get a username made from their name and their PIN as their password, so nobody is locked out;
 * an admin can then set proper passwords from Users.
 */
export const passwordLogin: Migration = {
  version: 48,
  name: "password_login",
  up(db) {
    db.exec("ALTER TABLE users ADD COLUMN username TEXT;");
    db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT NOT NULL DEFAULT '';");
    const taken = new Set<string>();
    const update = db.prepare("UPDATE users SET username = ?, password_hash = pin_hash WHERE id = ?");
    for (const user of db.prepare("SELECT id, name FROM users ORDER BY created_at, id").all() as Array<{ id: string; name: string }>) {
      update.run(usernameFromName(user.name, taken), user.id);
    }
    db.exec("CREATE UNIQUE INDEX users_username ON users (username COLLATE NOCASE);");
  },
};
