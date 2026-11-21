import "dotenv/config";

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/db/pool.js";

// Run this BEFORE pointing DATABASE_URL at Supabase. It reads the local/source
// database and writes INSERTs for organizations and user accounts only.
// Password hashes are copied verbatim (scrypt hashes, never plaintext).
const sourceUrl = process.env.SOURCE_DATABASE_URL ?? process.env.DATABASE_URL;
const outputPath = process.env.ACCOUNTS_SQL_PATH
  ?? fileURLToPath(new URL("../../database/supabase/accounts.sql", import.meta.url));

function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) return `'${value.toISOString()}'`;
  return `'${String(value).replaceAll("'", "''")}'`;
}

let pool;
try {
  if (!sourceUrl) throw new Error("Set SOURCE_DATABASE_URL (or DATABASE_URL) to the database that holds the accounts");
  if (sourceUrl.includes("pooler.supabase.com") && !process.env.SOURCE_DATABASE_URL) {
    throw new Error("DATABASE_URL already points to Supabase; set SOURCE_DATABASE_URL to the local database");
  }
  pool = createPool(sourceUrl);
  const [organizations, users] = await Promise.all([
    pool.query("SELECT id, name, type, verified, created_at, updated_at FROM organizations ORDER BY created_at, id"),
    pool.query(`SELECT id, organization_id, name, email_normalized, password_hash, role, status, created_at, updated_at
                FROM users ORDER BY created_at, id`),
  ]);

  const lines = [
    "-- Akun DanaTerang untuk dipindahkan ke Supabase.",
    "-- File ini MENGANDUNG password hash: jangan di-commit atau dibagikan.",
    "-- Dibuat otomatis oleh: npm run db:export-accounts --workspace @dana-terang/api",
    "-- Wallet binding sengaja tidak disalin; Verifier/Funder akan menghubungkan ulang.",
    "",
    "BEGIN;",
  ];
  for (const org of organizations.rows) {
    lines.push(`INSERT INTO organizations (id, name, type, verified, created_at, updated_at) VALUES (${literal(org.id)}, ${literal(org.name)}, ${literal(org.type)}, ${literal(org.verified)}, ${literal(org.created_at)}, ${literal(org.updated_at)}) ON CONFLICT DO NOTHING;`);
  }
  for (const user of users.rows) {
    lines.push(`INSERT INTO users (id, organization_id, name, email_normalized, password_hash, role, status, created_at, updated_at) VALUES (${literal(user.id)}, ${literal(user.organization_id)}, ${literal(user.name)}, ${literal(user.email_normalized)}, ${literal(user.password_hash)}, ${literal(user.role)}, ${literal(user.status)}, ${literal(user.created_at)}, ${literal(user.updated_at)}) ON CONFLICT DO NOTHING;`);
  }
  lines.push("COMMIT;", "");
  await writeFile(outputPath, lines.join("\n"), "utf8");
  console.log(`Exported ${organizations.rowCount} organization(s) and ${users.rowCount} account(s) to ${outputPath}`);
} catch (error) {
  console.error("Account export failed:", error?.message ?? String(error));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
