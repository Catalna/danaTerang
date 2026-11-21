import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { createPool } from "../src/db/pool.js";

/** PostgreSQL's WASM engine, in memory; no native service or credentials needed.
 * Lease its single connection through COMMIT/ROLLBACK so concurrent HTTP/worker
 * operations cannot read or commit another operation's unfinished transaction.
 */
export async function createTestPostgres() {
  if (process.env.NATIVE_TEST_DATABASE_URL) {
    const name = `danaterang_test_${randomUUID().replaceAll("-", "")}`;
    const connection = new URL(process.env.NATIVE_TEST_DATABASE_URL);
    const control = createPool(connection.href);
    try { await control.query(`CREATE DATABASE "${name}"`); }
    catch (error) { await control.end(); throw error; }
    connection.pathname = `/${name}`;
    const pool = createPool(connection.href);
    const end = pool.end.bind(pool);
    pool.end = async () => {
      try { await end(); await control.query(`DROP DATABASE "${name}"`); }
      finally { await control.end(); }
    };
    return pool;
  }
  const database = new PGlite();
  await database.waitReady;
  async function query(sql, parameters = []) {
    const result = parameters.length > 0
      ? await database.query(sql, parameters)
      : (await database.exec(sql)).at(-1);
    return { ...result, rows: result?.rows ?? [], rowCount: result?.rows?.length || result?.affectedRows || 0 };
  }
  let tail = Promise.resolve();
  async function acquire() {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    return release;
  }
  return {
    async query(...args) {
      const release = await acquire();
      try { return await query(...args); } finally { release(); }
    },
    async connect() { const release = await acquire(); return { query, release }; },
    async end() { await tail; await database.close(); },
  };
}
