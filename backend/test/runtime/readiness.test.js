import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { readMigrationStatus, runMigrations } from "../../src/db/migrate.js";
import { createReadinessService } from "../../src/runtime/readiness.js";
import { createLocalFileStorage } from "../../src/storage/localFileStorage.js";
import { createTestPostgres } from "../../testHelpers/postgres.js";

test("readiness distinguishes missing setup from healthy dependencies without mutating the schema", async (t) => {
  const pool = await createTestPostgres();
  t.after(() => pool.end());
  const directory = await mkdtemp(join(tmpdir(), "danaterang-readiness-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let ocrRunning = true;
  let workflowRunning = true;
  let rpcAvailable = true;
  const chain = { provider: { async getBlockNumber() { if (!rpcAvailable) throw new Error("private RPC credentials"); return 100; } } };
  const readiness = createReadinessService({
    pool, storage: createLocalFileStorage({ root: directory }), languageDataPath: directory,
    peerReviewChain: chain, proofAnchorChain: chain, cacheTtlMs: 0,
    isOcrRunning: () => ocrRunning, isWorkflowRunning: () => workflowRunning,
  });
  assert.ok((await readMigrationStatus(pool)).pending.includes("011_vote_relay_recovery"));
  assert.equal((await readiness.check()).checks.migrations, "missing");
  await assert.rejects(pool.query("SELECT * FROM schema_migrations"), { code: "42P01" });
  await runMigrations(pool);
  const missing = await readiness.check();
  assert.equal(missing.checks.admin, "missing");
  assert.equal(missing.checks.verifierRoster, "missing");
  assert.equal(missing.checks.ocr, "missing");
  await pool.query(
    `INSERT INTO users (id, name, email_normalized, password_hash, role, created_at, updated_at)
     VALUES ($1, 'Admin', 'ready-admin@example.test', 'synthetic', 'ADMIN', $2, $2)`, [randomUUID(), new Date()],
  );
  for (const index of [1, 2, 3]) {
    const organizationId = randomUUID();
    const userId = randomUUID();
    await pool.query("INSERT INTO organizations (id, name, type, created_at, updated_at) VALUES ($1, 'Independent', 'NGO', $2, $2)", [organizationId, new Date()]);
    await pool.query(
      `INSERT INTO users (id, organization_id, name, email_normalized, password_hash, role, created_at, updated_at)
       VALUES ($1, $2, 'Verifier', $3, 'synthetic', 'VERIFIER', $4, $4)`, [userId, organizationId, `ready-${index}@example.test`, new Date()],
    );
    await pool.query(
      `INSERT INTO verifier_wallets (verifier_user_id, wallet_address, organization_id, roster_version, verified_at, created_at)
       VALUES ($1, $2, $3, 1, $4, $4)`, [userId, `0x${String(index).repeat(40)}`, organizationId, new Date()],
    );
  }
  for (const language of ["eng", "ind"]) await writeFile(join(directory, `${language}.traineddata`), "synthetic presence check");
  const app = createApp({ readinessService: readiness });
  const ready = await request(app).get("/api/ready").expect(200);
  assert.equal(ready.headers["cache-control"], "no-store");
  assert.equal(ready.body.status, "ready");
  ocrRunning = false;
  workflowRunning = false;
  rpcAvailable = false;
  const degraded = await request(app).get("/api/ready").expect(503);
  assert.equal(degraded.body.checks.ocr, "not_running");
  assert.equal(degraded.body.checks.workflow, "not_running");
  assert.equal(degraded.body.checks.peerReview, "unavailable");
  assert.equal(JSON.stringify(degraded.body).includes("credentials"), false);
  await request(app).get("/api/health").expect(200);
});

test("readiness bounds slow dependencies, shares concurrent probes, and expires its cache", async () => {
  let count = 0;
  let time = 0;
  const service = createReadinessService({
    pool: { query() { count += 1; return new Promise(() => {}); } },
    timeoutMs: 10, cacheTtlMs: 100, now: () => time,
  });
  const first = service.check();
  assert.equal(first, service.check());
  assert.equal((await first).checks.database, "unavailable");
  await service.check();
  assert.equal(count, 1);
  time = 101;
  await service.check();
  assert.equal(count, 2);
  await request(createApp()).get("/api/ready").expect(503);
});
