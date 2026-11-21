import "dotenv/config";

import { readFile } from "node:fs/promises";
import { createPool } from "../src/db/pool.js";

const HARDEN_SQL_URL = new URL("../../database/supabase/harden.sql", import.meta.url);

let pool;
try {
  pool = createPool();
  const sql = await readFile(HARDEN_SQL_URL, "utf8");
  await pool.query(sql);
  console.log("Supabase public-schema grants revoked for anon/authenticated/service_role.");
} catch (error) {
  console.error("Supabase hardening failed. Check DATABASE_URL and the SQL role's privileges.");
  if (error?.message) console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
