import { Pool, types } from "pg";

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("DATABASE_URL is required for PostgreSQL");
  const pool = new Pool({
    connectionString,
    max: 10,
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
