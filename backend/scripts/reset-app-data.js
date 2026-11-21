import "dotenv/config";

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/db/pool.js";

const RESET_SQL_URL = new URL("../../database/supabase/reset-application-data.sql", import.meta.url);

let pool;
try {
  // Refuse to wipe a database that still holds migrations from a different app.
  pool = createPool();
  const status = await pool.query("SELECT COUNT(*)::int AS count FROM schema_migrations");
  if (status.rows[0].count === 0) throw new Error("No DanaTerang migrations found; refusing to reset");
  await pool.query(await readFile(RESET_SQL_URL, "utf8"));
  const remaining = await pool.query("SELECT COUNT(*)::int AS count FROM users");
  console.log(`Operational data cleared. ${remaining.rows[0].count} account(s) kept.`);
} catch (error) {
  console.error("Reset failed. Check DATABASE_URL and that migrations were applied first.");
  if (error?.message) console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
