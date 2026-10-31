// Operator-only: the first ForkFlow Portal admin. Hashes the password on this PC and prints the SQL to run with wrangler, so neither the
// password nor a bootstrap secret ever reaches the Worker. Every later staff account is added from the portal itself.
// node --import tsx tools/portal-create-admin.ts admin@forkflow.in "Vaibhav"   (asks for the password; it is not echoed)
// With --sql only the INSERT goes to stdout (prompts go to stderr), for the Node/SQLite server:
//   node --import tsx tools/portal-create-admin.ts --sql admin@forkflow.in "Vaibhav" | ssh <server> "sudo -u forkflow sqlite3 /var/lib/forkflow-portal/licensing.db"
import { randomUUID } from "node:crypto";
import { stderr, stdin, stdout } from "node:process";
import { parseArgs } from "node:util";
import { hashPassword, MIN_PASSWORD_LENGTH } from "../apps/licensing-worker/src/portal/passwords.js";

const { positionals, values } = parseArgs({ allowPositionals: true, options: { sql: { type: "boolean" } } });
// Prompts go to stderr in --sql mode so a pipe carries nothing but the statement.
const prompt = values.sql ? stderr : stdout;
const [email, name] = positionals;
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name) throw new Error('Usage: portal-create-admin.ts [--sql] <email> "<name>"');

/** Reads one line from the terminal without showing it. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) return reject(new Error("Run this in a terminal so the password can be typed without showing it."));
    prompt.write(question);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8");
    let text = "";
    const onData = (key: string) => {
      for (const char of key) {
        if (char === "\u0003") { stdin.setRawMode(false); process.exit(130); }
        if (char === "\r" || char === "\n") { stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData); prompt.write("\n"); return resolve(text); }
        text = char === "\u007f" || char === "\b" ? text.slice(0, -1) : text + char;
      }
    };
    stdin.on("data", onData);
  });
}

const password = await askHidden("Password for the new admin: ");
if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
if ((await askHidden("Type it again: ")) !== password) throw new Error("The passwords do not match.");

const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
const now = Date.now();
// must_change_password is 0: this admin chose their own password just now.
const sql = `INSERT INTO staff_users (id, email, name, role, password_hash, must_change_password, created_at, updated_at) VALUES (${[
  quote(randomUUID()), quote(email.toLowerCase()), quote(name), quote("admin"), quote(await hashPassword(password)), "0", String(now), String(now),
].join(", ")});`;
if (values.sql) { console.log(sql); process.exit(0); }
console.log(`\nRun this from apps/licensing-worker. For the test Worker use forkflow-licensing-test and add --env test; for wrangler dev use --local instead of --remote:\n`);
console.log(`npx wrangler@4 d1 execute forkflow-licensing --remote --command "${sql.replace(/"/g, '\\"')}"\n`);
