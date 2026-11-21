import { Pool, types } from "pg";

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("DATABASE_URL is required for PostgreSQL");
  // A hosted pooler caps total connections; keep the per-process ceiling
  // configurable so several serverless instances can share one database.
  const rawMax = process.env.DATABASE_POOL_MAX;
  if (rawMax !== undefined && (!/^\d+$/.test(rawMax) || Number(rawMax) < 1 || Number(rawMax) > 50)) {
    throw new Error("DATABASE_POOL_MAX must be an integer from 1 to 50");
  }
  const pool = new Pool({
    connectionString,
    max: rawMax === undefined ? 10 : Number(rawMax),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    // SQL DATE is a calendar date, not a local-midnight instant. Converting it
    // to Date shifts it to the previous day when serialized in UTC in Indonesia.
    types: {
      getTypeParser(oid, format) {
        return oid === 1082 && format !== "binary" ? (value) => value : types.getTypeParser(oid, format);
      },
    },
  });
  pool.on("error", (err) => {
    console.error("PostgreSQL pool idle client error:", err.message);
  });
  return pool;
}
