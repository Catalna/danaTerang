import "dotenv/config";

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/db/pool.js";

// Run after db:migrate on the Supabase database. The SQL file is produced by
// db:export-accounts from the old database and contains password hashes only.
const sqlPath = process.env.ACCOUNTS_SQL_PATH
  ?? fileURLToPath(new URL("../../database/supabase/accounts.sql", import.meta.url));

let pool;
try {
  const sql = await readFile(sqlPath, "utf8");
  if (!sql.includes("INSERT INTO users")) throw new Error("Account SQL file is empty or invalid");
  pool = createPool();
  await pool.query(sql);
  const result = await pool.query("SELECT COUNT(*)::int AS count FROM users");
  console.log(`Accounts imported. Users in target database: ${result.rows[0].count}`);
} catch (error) {
  console.error("Account import failed. Check DATABASE_URL and that migrations were applied first.");
  if (error?.message) console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
