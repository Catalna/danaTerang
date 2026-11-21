import { Pool, types } from "pg";

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("DATABASE_URL is required for PostgreSQL");
  // A hosted pooler caps total connections; keep the per-process ceiling
  // configurable so several serverless instances can share one database.
  const rawMax = process.env.DATABASE_POOL_MAX;
  if (rawMax !== undefined && (!/^\d+$/.test(rawMax) || Number(rawMax) < 1 || Number(rawMax) > 50)) {
    throw new Error("DATABASE_POOL_MAX must be an integer from 1 to 50");
  }
  // Hosted providers (e.g. the Supabase pooler) present CA chains that Node's
  // trust store does not include. DATABASE_SSL_REJECT_UNAUTHORIZED=false keeps
  // the connection encrypted while accepting those chains; the default stays
  // verify-full. Supply DATABASE_SSL_ROOT_CERT instead when the provider CA is
  // available for strict verification.
  const sslRejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED;
  if (sslRejectUnauthorized !== undefined && !["true", "false"].includes(sslRejectUnauthorized)) {
    throw new Error("DATABASE_SSL_REJECT_UNAUTHORIZED must be true or false");
  }
  const sslRootCert = process.env.DATABASE_SSL_ROOT_CERT;
  const ssl = sslRejectUnauthorized === "false" || sslRootCert
    ? { rejectUnauthorized: sslRejectUnauthorized === "false" ? false : true, ...(sslRootCert ? { ca: sslRootCert } : {}) }
    : undefined;
  // pg-connection-string treats sslmode=require as verify-full and overrides a
  // custom ssl object; strip the query param so the explicit ssl config applies.
  let poolConnectionString = connectionString;
  if (ssl && /sslmode=/.test(connectionString)) {
    poolConnectionString = connectionString
      .replace(/([?&])sslmode=[^&]*/g, "$1")
      .replace(/\?&/, "?")
      .replace(/&&/g, "&")
      .replace(/[?&]$/, "");
  }
  const pool = new Pool({
    connectionString: poolConnectionString,
    ...(ssl ? { ssl } : {}),
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
