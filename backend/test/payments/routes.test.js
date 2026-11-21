import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { createSessionToken } from "../../src/auth/sessionTokens.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createAuthRepository } from "../../src/repositories/authRepository.js";
import { createCampaignRepository } from "../../src/repositories/campaignRepository.js";
import { createPaymentRepository } from "../../src/repositories/paymentRepository.js";
import { createTestPostgres } from "../../testHelpers/postgres.js";

const ORIGIN = "http://localhost:3000";

test("payment reports enforce funder ownership, verified evidence, exact budgets, idempotency and private projections", async (t) => {
  const pool = await createTestPostgres();
  t.after(() => pool.end());
  await runMigrations(pool);
  const auth = createAuthRepository(pool);
  const campaigns = createCampaignRepository(pool);
  const payments = createPaymentRepository(pool);
  const admin = (await auth.createFirstAdmin({ name: "Admin", email: "admin@example.test", passwordHash: "test-hash" })).user;
  const users = [admin];
  for (const [index, role] of ["ORGANIZER", "FUNDER", "FUNDER", "ORGANIZER", "VERIFIER"].entries()) {
    const session = createSessionToken();
    const email = `user-${index}@example.test`;
    await auth.registerOrganizer({
      name: `User ${index}`, email, passwordHash: "test-hash", organizationName: `Organization ${index}`, organizationType: "NGO",
      sessionTokenHash: session.tokenHash, sessionExpiresAt: new Date("2030-01-01"),
    });
    const candidate = await auth.findUserByEmail(email);
    if (role !== "ORGANIZER") await auth.assignRoleAndAudit({ actorUserId: admin.id, targetUserId: candidate.id, role });
    users.push(await auth.findUserByEmail(email));
  }
  const [, organizer, funder, otherFunder, otherOrganizer, verifier] = users;
  const cookies = new Map();
  for (const user of users) {
    const session = createSessionToken();
    await auth.createSession({ userId: user.id, tokenHash: session.tokenHash, expiresAt: new Date("2030-01-01") });
    cookies.set(user.id, `dt_session=${session.token}`);
  }
  const app = createApp({ authRepository: auth, campaignRepository: campaigns, paymentRepository: payments, webOrigin: ORIGIN, nodeEnv: "test" });
  const campaign = await campaigns.createCampaign({ actor: organizer, funderId: funder.id, title: "Private funding", totalBudget: "999999999999999999.99", currency: "IDR" });
  const milestone = await campaigns.createMilestone({ actor: organizer, campaignId: campaign.id, title: "Supplies", budgetAmount: "999999999999999999.99", currency: "IDR", orderIndex: 0 });
  await campaigns.activateCampaign({ actor: funder, campaignId: campaign.id });
  function api(method, path, user) {
    const operation = request(app)[method](`/api${path}`).set("Origin", ORIGIN);
    return user ? operation.set("Cookie", cookies.get(user.id)) : operation;
  }
  const path = `/milestones/${milestone.id}/payment-reports`;
  const body = { requestId: randomUUID(), reportedAmount: "999999999999999998.99", currency: "IDR", paidAt: "2026-01-01", transactionReference: "PRIVATE-TRANSFER-123", notes: "Private bank notes" };
  await api("get", "/payment-reports").expect(401);
  await api("get", "/payment-reports", verifier).expect(403);
  await api("post", path, organizer).send(body).expect(403);
  await api("post", path, admin).send(body).expect(403);
  await api("post", path, otherFunder).send(body).expect(404);
  await api("post", path, funder).set("Origin", "http://untrusted.test").send(body).expect(403);
  assert.equal((await api("post", path, funder).send(body).expect(409)).body.error, "payment_not_ready");
  assert.deepEqual((await api("get", "/payment-reports", funder).expect(200)).body.eligibleMilestones, []);

  // Persist a version-specific confirmed quorum fixture; signatures/chain are covered by the MVP suite.
  const evidenceId = randomUUID();
  const roundId = randomUUID();
  await pool.query(`INSERT INTO evidence (id, milestone_id, uploader_id, evidence_type, storage_key, file_name, content_type, file_size, raw_hash, version_group_id, version, status, created_at, updated_at)
    VALUES ($1, $2, $3, 'RECEIPT', $4, 'private.png', 'image/png', 100, $5, $6, 1, 'READY_FOR_REVIEW', NOW(), NOW())`,
  [evidenceId, milestone.id, organizer.id, randomUUID(), "a".repeat(64), randomUUID()]);
  const commitment = `0x${"a".repeat(64)}`;
  const address = `0x${"c".repeat(40)}`;
  await pool.query(`INSERT INTO review_rounds (id, evidence_id, round_number, review_id, evidence_commitment, organizer_organization_commitment, funder_organization_commitment, status, decision, roster_version, contract_address, quorum_transaction_hash, block_number, created_at, updated_at)
    VALUES ($1, $2, 1, $3, $3, $3, $3, 'QUORUM_REACHED', 'VERIFIED', 1, $4, $3, 10, NOW(), NOW())`, [roundId, evidenceId, commitment, address]);
  await pool.query(`INSERT INTO verifications (id, evidence_id, review_round_id, status, contract_address, transaction_hash, block_number, created_at, updated_at)
    VALUES ($1, $2, $3, 'VERIFIED', $4, $5, 10, NOW(), NOW())`, [randomUUID(), evidenceId, roundId, address, commitment]);

  const eligible = (await api("get", "/payment-reports", funder).expect(200)).body.eligibleMilestones;
  assert.equal(eligible[0].remainingAmount, "999999999999999999.99");
  for (const invalid of [{ reportedAmount: "1000000000000000000" }, { reportedAmount: "0" }, { reportedAmount: 1.25 }, { status: "CONFIRMED" }, { paidAt: "2099-01-01" }, { paidAt: "2026-02-30" }]) {
    await api("post", path, funder).send({ ...body, ...invalid }).expect(400);
  }
  const saved = (await api("post", path, funder).send(body).expect(201)).body.report;
  assert.equal(saved.reportedAmount, body.reportedAmount);
  assert.equal(saved.status, "PAYMENT_REPORTED");
  assert.equal(saved.paidAt, body.paidAt, "calendar dates must not shift with the PostgreSQL client's timezone");
  assert.equal((await api("post", path, funder).send(body).expect(200)).body.report.id, saved.id);
  await api("post", path, funder).send({ ...body, reportedAmount: "1.00" }).expect(409);
  const audit = await pool.query("SELECT details FROM audit_logs WHERE action = 'PAYMENT_REPORTED'");
  assert.equal(audit.rowCount, 1);
  assert.ok(!JSON.stringify(audit.rows).includes(body.transactionReference));
  assert.equal((await api("get", "/payment-reports", funder).expect(200)).body.eligibleMilestones[0].remainingAmount, "1.00");
  await api("post", path, funder).send({ ...body, requestId: randomUUID(), reportedAmount: "1.01" }).expect(409);
  await api("post", path, funder).send({ ...body, requestId: randomUUID(), reportedAmount: "1.00", currency: "USD" }).expect(400);
  const competing = await Promise.all([0, 1].map(() => api("post", path, funder).send({ ...body, requestId: randomUUID(), reportedAmount: "1.00" })));
  assert.deepEqual(competing.map((response) => response.status).sort(), [201, 409], "concurrent reports cannot overspend the last remaining amount");
  assert.deepEqual((await api("get", "/payment-reports", funder).expect(200)).body.eligibleMilestones, []);
  const organizerReports = (await api("get", "/payment-reports", organizer).expect(200)).body.reports;
  assert.equal(organizerReports.length, 2);
  assert.equal(organizerReports[0].transactionReference, body.transactionReference);
  for (const outsider of [otherFunder, otherOrganizer]) assert.deepEqual((await api("get", "/payment-reports", outsider).expect(200)).body.reports, []);
  const adminReports = (await api("get", "/payment-reports", admin).expect(200)).body.reports;
  assert.equal(adminReports.length, 2);
  assert.ok(!JSON.stringify(adminReports).includes(body.transactionReference));
  assert.ok(!JSON.stringify(adminReports).includes(body.notes));
  await campaigns.setCampaignPublication({ actor: admin, campaignId: campaign.id, published: true });
  const publicData = (await api("get", `/public/campaigns/${campaign.id}`).expect(200)).body;
  assert.ok(!JSON.stringify(publicData).includes(body.transactionReference));
  assert.ok(!JSON.stringify(publicData).includes("payment"));

  const contestedCampaign = await campaigns.createCampaign({ actor: organizer, funderId: funder.id, title: "Concurrent allocations", totalBudget: "100", currency: "IDR" });
  const allocations = await Promise.allSettled([0, 1].map((orderIndex) => campaigns.createMilestone({
    actor: organizer, campaignId: contestedCampaign.id, title: `Allocation ${orderIndex}`, budgetAmount: "60", currency: "IDR", orderIndex,
  })));
  assert.equal(allocations.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(allocations.find((result) => result.status === "rejected").reason.code, "BUDGET_CONSTRAINT");
  assert.equal((await campaigns.listMilestonesForCampaign(organizer, contestedCampaign.id)).length, 1);
});
