import { stat } from "node:fs/promises";
import { join } from "node:path";
import { readMigrationStatus } from "../db/migrate.js";

/** Read-only, allowlisted checks for the complete demo configuration. */
export function createReadinessService({ pool, storage, languageDataPath, peerReviewChain, proofAnchorChain,
  isOcrRunning = () => true, isWorkflowRunning,
  cacheTtlMs = 5000, timeoutMs = 5000, now = Date.now } = {}) {
  let cached;
  let expiresAt = 0;
  let pending;
  async function probe(operation) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((resolve) => { timer = setTimeout(() => resolve("unavailable"), timeoutMs); }),
      ]);
    } catch { return "unavailable"; }
    finally { clearTimeout(timer); }
  }

  async function inspect() {
    const checks = {};
    checks.database = pool ? await probe(async () => { await pool.query("SELECT 1"); return "ok"; }) : "not_configured";
    checks.migrations = checks.database === "ok" ? await probe(async () => {
      const migrations = await readMigrationStatus(pool);
      return migrations.pending.length === 0 ? "ok" : "missing";
    }) : "unavailable";
    const databaseReady = checks.migrations === "ok";
    const results = await Promise.all([
      databaseReady ? probe(async () => {
        const result = await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'");
        return Number(result.rows[0].count) > 0 ? "ok" : "missing";
      }) : "unavailable",
      databaseReady ? probe(async () => {
        const result = await pool.query(
          `SELECT COUNT(*)::int AS count FROM verifier_wallets vw JOIN users u ON u.id = vw.verifier_user_id
           WHERE vw.status = 'ACTIVE' AND u.status = 'ACTIVE' AND u.role = 'VERIFIER'`,
        );
        return Number(result.rows[0].count) === 3 ? "ok" : "missing";
      }) : "unavailable",
      storage ? probe(async () => { await storage.checkReady(); return "ok"; }) : "not_configured",
      languageDataPath ? probe(async () => {
        for (const language of ["eng", "ind"]) {
          let file;
          try { file = await stat(join(languageDataPath, `${language}.traineddata`)); }
          catch (error) { if (error?.code === "ENOENT") return "missing"; throw error; }
          if (!file.isFile() || file.size < 1) return "missing";
        }
        return isOcrRunning() ? "ok" : "not_running";
      }) : "not_configured",
      peerReviewChain ? probe(async () => { await peerReviewChain.provider.getBlockNumber(); return "ok"; }) : "not_configured",
      proofAnchorChain ? probe(async () => { await proofAnchorChain.provider.getBlockNumber(); return "ok"; }) : "not_configured",
    ]);
    [checks.admin, checks.verifierRoster, checks.storage, checks.ocr, checks.peerReview, checks.proofAnchor] = results;
    if (isWorkflowRunning) checks.workflow = isWorkflowRunning() ? "ok" : "not_running";
    return { status: Object.values(checks).every((status) => status === "ok") ? "ready" : "not_ready", service: "dana-terang-api", checks };
  }
  return Object.freeze({
    check() {
      if (pending) return pending;
      if (cached && now() < expiresAt) return Promise.resolve(cached);
      pending = inspect().then((result) => { cached = result; expiresAt = now() + cacheTtlMs; return result; })
        .finally(() => { pending = null; });
      return pending;
    },
  });
}
