import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import request from "supertest";
import { newDb } from "pg-mem";

import { createApp } from "../../src/app.js";
import { hashPassword } from "../../src/auth/passwords.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createFundraisingRepository } from "../../src/fundraising/fundraisingRepository.js";
import { createFundraisingService } from "../../src/fundraising/fundraisingService.js";
import { createAuthRepository } from "../../src/repositories/authRepository.js";
import { createCampaignRepository } from "../../src/repositories/campaignRepository.js";
import { createSimulatedPaymentProvider } from "../../src/fundraising/simulatedPaymentProvider.js";

const WEB_ORIGIN = "http://localhost:3000";
const PASSWORD = "correct horse battery staple";

async function fixture({ closeAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000) } = {}) {
  const memoryDb = newDb();
  memoryDb.public.registerFunction({ name: "trim", args: ["text"], returns: "text", implementation: (value) => value.trim() });
  memoryDb.public.registerFunction({ name: "length", args: ["text"], returns: "integer", implementation: (value) => value.length });
  const { Pool } = memoryDb.adapters.createPg();
  const pool = new Pool();
  await runMigrations(pool);
  const authRepository = createAuthRepository(pool);
  const admin = await authRepository.createFirstAdmin({ name: "Admin", email: "admin@example.com", passwordHash: await hashPassword(PASSWORD) });
  const organizerAccount = await authRepository.registerOrganizer({
    name: "Organizer", email: "organizer@example.com", passwordHash: await hashPassword(PASSWORD),
    organizationName: "Relief Community", organizationType: "COMMUNITY",
    sessionTokenHash: "b".repeat(64), sessionExpiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
  });
  const funderAccount = await authRepository.registerAccount({
    role: "FUNDER", name: "Donor", email: "donor@example.com", passwordHash: await hashPassword(PASSWORD),
    sessionTokenHash: "a".repeat(64), sessionExpiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
  });
  const campaignId = randomUUID();
  const campaignRepository = createCampaignRepository(pool);
  const publishedAt = new Date();
  await pool.query(
    `INSERT INTO campaigns (
      id, organization_id, funder_id, title, description, cause_category, total_budget, currency,
      funding_mode, status, fundraising_status, fundraising_close_at, publicly_published_at,
      published_by, created_at, updated_at
    ) VALUES ($1, $2, NULL, 'Disaster Relief', 'Flood recovery', 'DISASTER_RELIEF', '50000000.00', 'IDR',
      'EXTERNAL_TRACKING', 'DRAFT', 'OPEN', $3, $4, $5, $4, $4)`,
    [campaignId, organizerAccount.user.organizationId, closeAt, publishedAt, admin.user.id],
  );

  const fundraisingRepository = createFundraisingRepository(pool);
  const provider = {
    name: "test-provider",
    async createCheckout({ reference }) {
      return { paymentId: `payment-${reference}`, checkoutUrl: `https://payments.example/checkout/${reference}` };
    },
    async createPayout({ reference }) {
      return { payoutId: `payout-${reference}` };
    },
    async quotePayout() { return { fee: "200.00" }; },
    async verifyWebhook({ headers, body }) {
      if (headers["x-test-signature"] !== "valid") throw new Error("Invalid test signature");
      return body;
    },
  };
  const fundraisingService = createFundraisingService({ repository: fundraisingRepository, paymentProvider: provider });
  const app = createApp({ authRepository, campaignRepository, fundraisingService, webOrigin: WEB_ORIGIN, nodeEnv: "test" });
  return { app, pool, authRepository, fundraisingRepository, campaignRepository, campaignId, closeAt, funderAccount, organizerAccount, adminAccount: admin.user };
}

function sessionCookie(response) {
  const cookie = response.headers["set-cookie"]?.find((value) => value.startsWith("dt_session="));
  assert.ok(cookie, "response should set a session cookie");
  return cookie.split(";")[0];
}

async function login(app, email) {
  const response = await request(app)
    .post("/api/auth/login")
    .set("Origin", WEB_ORIGIN)
    .send({ email, password: PASSWORD })
    .expect(200);
  return sessionCookie(response);
}

test("authenticated Funder donations settle idempotently into escrow and reconcile fees", async () => {
  const context = await fixture();
  try {
    const donorCookie = await login(context.app, "donor@example.com");
    assert.ok(await context.fundraisingRepository.getOpenCampaign(context.campaignId), "public fundraising projection should find the open campaign");
    const publicList = await request(context.app).get("/api/public/fundraising-campaigns").expect(200);
    assert.equal(publicList.body.campaigns.length, 1, JSON.stringify((await context.pool.query("SELECT id, organization_id, fundraising_status, fundraising_close_at, publicly_published_at FROM campaigns")).rows));
    assert.equal(publicList.body.campaigns[0].fundraisingTarget, "50000000.00");
    assert.equal(publicList.body.campaigns[0].grossRaised, "0.00");

    const idempotencyKey = randomUUID();
    const checkout = await request(context.app)
      .post(`/api/campaigns/${context.campaignId}/donations`)
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", donorCookie)
      .send({
        amount: "60000000.00",
        idempotencyKey,
        reallocationPolicy: "REDIRECT_RELATED",
        returnUrl: `${WEB_ORIGIN}/donations/complete`,
      })
      .expect(201);
    assert.equal(checkout.body.donation.status, "PENDING");
    assert.equal(checkout.body.donation.checkoutUrl.startsWith("https://payments.example/"), true);
    assert.equal(checkout.body.donation.amount, "60000000.00");

    const providerEvent = {
      eventId: "evt-1",
      type: "PAYMENT_SETTLED",
      paymentId: `payment-${checkout.body.donation.id}`,
      amount: "60000000.00",
      fee: "300000.00",
      currency: "IDR",
    };
    const settled = await request(context.app)
      .post("/api/fundraising/webhooks/test-provider")
      .set("x-test-signature", "valid")
      .send(providerEvent)
      .expect(200);
    assert.equal(settled.body.duplicate, false);

    const duplicate = await request(context.app)
      .post("/api/fundraising/webhooks/test-provider")
      .set("x-test-signature", "valid")
      .send(providerEvent)
      .expect(200);
    assert.equal(duplicate.body.duplicate, true);

    const campaign = await request(context.app).get(`/api/public/fundraising-campaigns/${context.campaignId}`).expect(200);
    assert.equal(campaign.body.campaign.grossRaised, "60000000.00");
    assert.equal(campaign.body.campaign.goalPercent, 120);
    const donations = await request(context.app).get("/api/fundraising/donations").set("Cookie", donorCookie).expect(200);
    assert.equal(donations.body.donations.length, 1);
    assert.equal(donations.body.donations[0].status, "PAID");
    assert.deepEqual(await context.fundraisingRepository.getCampaignReconciliation({ actor: context.adminAccount, campaignId: context.campaignId }), {
      donations: "60000000.00",
      providerFees: "300000.00",
      milestonePayouts: "0.00",
      refunds: "0.00",
      transfersIn: "0.00",
      transfersOut: "0.00",
      platformSupport: "0.00",
      escrow: "59700000.00",
    });
  } finally {
    await context.pool.end();
  }
});

test("donations require an authenticated Funder and close at the scheduled deadline", async () => {
  const context = await fixture({ closeAt: new Date(Date.now() - 1000) });
  try {
    const idempotencyKey = randomUUID();
    const payload = {
      amount: "100.00",
      idempotencyKey,
      reallocationPolicy: "REFUND",
      returnUrl: `${WEB_ORIGIN}/donations/complete`,
    };
    await request(context.app).post(`/api/campaigns/${context.campaignId}/donations`).set("Origin", WEB_ORIGIN).send(payload).expect(401);

    const organizerCookie = await login(context.app, "organizer@example.com");
    await request(context.app)
      .post(`/api/campaigns/${context.campaignId}/donations`)
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", organizerCookie)
      .send(payload)
      .expect(403);

    const donorCookie = await login(context.app, "donor@example.com");
    const closed = await request(context.app)
      .post(`/api/campaigns/${context.campaignId}/donations`)
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", donorCookie)
      .send(payload)
      .expect(409);
    assert.deepEqual(closed.body, { error: "fundraising_closed" });
  } finally {
    await context.pool.end();
  }
});

test("checkout fails closed until a real Rupiah payment provider is configured", async () => {
  const context = await fixture();
  try {
    const noProviderService = createFundraisingService({ repository: context.fundraisingRepository, paymentProvider: null });
    const app = createApp({ authRepository: context.authRepository, campaignRepository: context.campaignRepository, fundraisingService: noProviderService, webOrigin: WEB_ORIGIN, nodeEnv: "test" });
    const donorCookie = await login(app, "donor@example.com");
    const response = await request(app)
      .post(`/api/campaigns/${context.campaignId}/donations`)
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", donorCookie)
      .send({ amount: "100.00", idempotencyKey: randomUUID(), reallocationPolicy: "REFUND", returnUrl: `${WEB_ORIGIN}/return` })
      .expect(503);
    assert.deepEqual(response.body, { error: "payment_provider_unavailable" });
  } finally {
    await context.pool.end();
  }
});

test("a local-only fake payment session can settle only its authenticated donor's donation", async () => {
  const context = await fixture();
  try {
    const provider = createSimulatedPaymentProvider({ webOrigin: WEB_ORIGIN });
    const service = createFundraisingService({ repository: context.fundraisingRepository, paymentProvider: provider });
    const app = createApp({ authRepository: context.authRepository, campaignRepository: context.campaignRepository, fundraisingService: service, webOrigin: WEB_ORIGIN, nodeEnv: "test" });
    const donorCookie = await login(app, "donor@example.com");
    const checkout = await request(app)
      .post(`/api/campaigns/${context.campaignId}/donations`)
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", donorCookie)
      .send({ amount: "2500.00", idempotencyKey: randomUUID(), reallocationPolicy: "REFUND", returnUrl: `${WEB_ORIGIN}/return` })
      .expect(201);
    const settled = await request(app)
      .post(`/api/test/fundraising/donations/${checkout.body.donation.id}/settle`)
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", donorCookie)
      .send({})
      .expect(200);
    assert.equal(settled.body.donation.status, "PAID");
    const organizerCookie = await login(app, "organizer@example.com");
    await request(app)
      .post(`/api/test/fundraising/donations/${checkout.body.donation.id}/settle`)
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", organizerCookie)
      .send({})
      .expect(403);
    assert.deepEqual(await context.fundraisingRepository.getCampaignReconciliation({ actor: context.adminAccount, campaignId: context.campaignId }), {
      donations: "2500.00", providerFees: "0.00", milestonePayouts: "0.00", refunds: "0.00",
      transfersIn: "0.00", transfersOut: "0.00", platformSupport: "0.00", escrow: "2500.00",
    });
  } finally {
    await context.pool.end();
  }
});

test("development payment simulation settles a donor-owned checkout without a real transfer", async () => {
  const context = await fixture();
  try {
    const simulatedService = createFundraisingService({
      repository: context.fundraisingRepository,
      paymentProvider: createSimulatedPaymentProvider({ webOrigin: WEB_ORIGIN }),
    });
    const app = createApp({ authRepository: context.authRepository, campaignRepository: context.campaignRepository, fundraisingService: simulatedService, webOrigin: WEB_ORIGIN, nodeEnv: "test" });
    const donorCookie = await login(app, "donor@example.com");
    const checkout = await request(app)
      .post(`/api/campaigns/${context.campaignId}/donations`)
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", donorCookie)
      .send({ amount: "1000.00", idempotencyKey: randomUUID(), reallocationPolicy: "REFUND", returnUrl: `${WEB_ORIGIN}/return` })
      .expect(201);
    assert.match(checkout.body.donation.checkoutUrl, /\/fundraising\/demo-checkout\?/);
    const simulated = await request(app)
      .post(`/api/test/fundraising/donations/${checkout.body.donation.id}/settle`)
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", donorCookie)
      .send({})
      .expect(200);
    assert.equal(simulated.body.donation.status, "PAID");
    assert.equal(simulated.body.donation.amount, "1000.00");
  } finally {
    await context.pool.end();
  }
});

test("new campaigns open public fundraising only after an Admin publishes them", async () => {
  const context = await fixture();
  try {
    const organizerCookie = await login(context.app, "organizer@example.com");
    const campaignResponse = await request(context.app)
      .post("/api/campaigns")
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", organizerCookie)
      .send({
        title: "Community Flood Response",
        description: "Emergency supplies and repairs",
        totalBudget: "50000000.00",
        currency: "IDR",
        fundraisingCloseAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .expect(201);
    const campaign = campaignResponse.body.campaign;
    assert.equal(campaign.funderId, null);
    assert.equal(campaign.fundraisingStatus, "DRAFT");

    await request(context.app)
      .post(`/api/campaigns/${campaign.id}/milestones`)
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", organizerCookie)
      .send({ title: "Emergency supplies", budgetAmount: "50000000.00", currency: "IDR", orderIndex: 0 })
      .expect(201);

    const adminCookie = await login(context.app, "admin@example.com");
    const publish = await request(context.app)
      .patch(`/api/admin/campaigns/${campaign.id}/publication`)
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", adminCookie)
      .send({ published: true })
      .expect(200);
    assert.equal(publish.body.campaign.published, true);
    const stored = await context.pool.query("SELECT fundraising_status FROM campaigns WHERE id = $1", [campaign.id]);
    assert.equal(stored.rows[0].fundraising_status, "OPEN");
    await request(context.app)
      .patch(`/api/campaigns/${campaign.id}`)
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", organizerCookie)
      .send({ description: "Update pertama untuk warga terdampak." })
      .expect(200);
    await request(context.app)
      .patch(`/api/campaigns/${campaign.id}`)
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", organizerCookie)
      .send({ description: "Update kedua untuk kebutuhan logistik." })
      .expect(200);
    const exhausted = await request(context.app)
      .patch(`/api/campaigns/${campaign.id}`)
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", organizerCookie)
      .send({ description: "Update ketiga tidak diizinkan." })
      .expect(409);
    assert.deepEqual(exhausted.body, { error: "amendments_exhausted" });
    assert.ok(await context.fundraisingRepository.getOpenCampaign(campaign.id), "newly published fundraising campaign should be available to donors");
    const publicCampaign = await request(context.app).get(`/api/public/fundraising-campaigns/${campaign.id}`);
    assert.equal(publicCampaign.status, 200, JSON.stringify(await context.pool.query("SELECT id, fundraising_status, fundraising_close_at, publicly_published_at FROM campaigns WHERE id = $1", [campaign.id])));
    assert.equal(publicCampaign.body.campaign.fundraisingTarget, "50000000.00");
    assert.equal(publicCampaign.body.campaign.grossRaised, "0.00");

    const revisions = await context.pool.query("SELECT version, amendment_number, snapshot FROM campaign_revisions WHERE campaign_id = $1 ORDER BY version ASC", [campaign.id]);
    assert.equal(revisions.rowCount, 3);
    assert.equal(revisions.rows[0].snapshot.milestones.length, 1);
    assert.deepEqual(revisions.rows.map((row) => row.amendment_number), [0, 1, 2]);
  } finally {
    await context.pool.end();
  }
});

test("fundraising stops at H-48 if the Organizer has not locked terms and queues paid donations for refund", async () => {
  const context = await fixture();
  try {
    const donorCookie = await login(context.app, "donor@example.com");
    const checkout = await request(context.app)
      .post(`/api/campaigns/${context.campaignId}/donations`)
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", donorCookie)
      .send({ amount: "100000.00", idempotencyKey: randomUUID(), reallocationPolicy: "REFUND", returnUrl: `${WEB_ORIGIN}/return` })
      .expect(201);
    await request(context.app)
      .post("/api/fundraising/webhooks/test-provider")
      .set("x-test-signature", "valid")
      .send({ eventId: "evt-cancel", type: "PAYMENT_SETTLED", paymentId: `payment-${checkout.body.donation.id}`, amount: "100000.00", fee: "5000.00", currency: "IDR" })
      .expect(200);

    const afterH48 = new Date(context.closeAt.getTime() - 48 * 60 * 60 * 1000 + 1_000);
    await assert.rejects(context.fundraisingRepository.createDonation({
      actor: context.funderAccount.user,
      campaignId: context.campaignId,
      amount: "100.00",
      idempotencyKey: randomUUID(),
      reallocationPolicy: "REFUND",
      provider: "test-provider",
      now: afterH48,
    }), { code: "CAMPAIGN_TERMS_REQUIRED" });

    const result = await context.fundraisingRepository.processFundraisingDeadlines({
      now: new Date(context.closeAt.getTime() - 48 * 60 * 60 * 1000 + 121_000),
    });
    assert.deepEqual(result.cancelledCampaignIds, [context.campaignId]);
    assert.equal(result.refundIds.length, 1);
    const campaign = await context.pool.query("SELECT status, fundraising_status FROM campaigns WHERE id = $1", [context.campaignId]);
    assert.equal(campaign.rows[0].status, "CANCELLED");
    assert.equal(campaign.rows[0].fundraising_status, "CANCELLED");
    const refund = await context.pool.query("SELECT status, amount, fee_subsidy, reason FROM fundraising_refunds WHERE donation_id = $1", [checkout.body.donation.id]);
    assert.equal(refund.rows[0].status, "PENDING");
    assert.equal(String(refund.rows[0].amount), "100000");
    assert.equal(String(refund.rows[0].fee_subsidy), "5000");
    assert.equal(refund.rows[0].reason, "CAMPAIGN_TERMS_UNSIGNED");
    await context.fundraisingRepository.attachProviderRefund({ refundId: result.refundIds[0], providerRefundId: "refund-terms-unsigned" });
    await context.fundraisingRepository.settleRefund({
      provider: "test-provider",
      providerEventId: "evt-refund-terms-unsigned",
      providerEventType: "REFUND_SETTLED",
      providerRefundId: "refund-terms-unsigned",
      amount: "100000.00",
      currency: "IDR",
    });
    const refundedDonation = await context.pool.query("SELECT status FROM fundraising_donations WHERE id = $1", [checkout.body.donation.id]);
    assert.equal(refundedDonation.rows[0].status, "REFUNDED");
    assert.deepEqual(await context.fundraisingRepository.getCampaignReconciliation({ actor: context.adminAccount, campaignId: context.campaignId }), {
      donations: "100000.00", providerFees: "5000.00", milestonePayouts: "0.00", refunds: "100000.00",
      transfersIn: "0.00", transfersOut: "0.00", platformSupport: "5000.00", escrow: "0.00",
    });
  } finally {
    await context.pool.end();
  }
});

test("a terms-locked campaign closes on schedule and becomes available for milestone execution", async () => {
  const context = await fixture();
  try {
    await context.pool.query(
      `UPDATE campaigns SET fundraising_status = 'LOCKED', terms_locked_at = $2, terms_commitment = $3 WHERE id = $1`,
      [context.campaignId, new Date(), `0x${"a".repeat(64)}`],
    );
    const result = await context.fundraisingRepository.processFundraisingDeadlines({ now: new Date(context.closeAt.getTime() + 1_000) });
    assert.deepEqual(result.closedCampaignIds, [context.campaignId]);
    const closed = await context.pool.query("SELECT status, fundraising_status FROM campaigns WHERE id = $1", [context.campaignId]);
    assert.equal(closed.rows[0].fundraising_status, "CLOSED");
    assert.equal(closed.rows[0].status, "ACTIVE");
  } finally {
    await context.pool.end();
  }
});

test("surplus can move only to a same-cause campaign when donors consent, with both ledgers balanced", async () => {
  const context = await fixture();
  try {
    const donation = await context.fundraisingRepository.createDonation({
      actor: context.funderAccount.user,
      campaignId: context.campaignId,
      amount: "100.00",
      reallocationPolicy: "REDIRECT_RELATED",
      idempotencyKey: randomUUID(),
      provider: "test-provider",
    });
    await context.fundraisingRepository.attachCheckout({
      donationId: donation.donation.id,
      donorId: context.funderAccount.user.id,
      providerPaymentId: `payment-${donation.donation.id}`,
      checkoutUrl: "https://payments.example/checkout",
    });
    await context.fundraisingRepository.settleDonation({
      provider: "test-provider",
      providerEventId: "evt-transfer",
      providerEventType: "PAYMENT_SETTLED",
      providerPaymentId: `payment-${donation.donation.id}`,
      amount: "100.00",
      fee: "0.00",
      currency: "IDR",
    });
    await context.pool.query("UPDATE campaigns SET fundraising_status = 'CLOSED', status = 'ACTIVE' WHERE id = $1", [context.campaignId]);

    const destinationId = randomUUID();
    const now = new Date();
    await context.pool.query(
      `INSERT INTO campaigns (
        id, organization_id, funder_id, title, description, cause_category, total_budget, currency,
        funding_mode, status, fundraising_status, fundraising_close_at, publicly_published_at, published_by,
        created_at, updated_at
      ) VALUES ($1, $2, NULL, 'Other Disaster Response', '', 'DISASTER_RELIEF', '1000.00', 'IDR',
        'EXTERNAL_TRACKING', 'DRAFT', 'OPEN', $3, $4, $5, $4, $4)`,
      [destinationId, context.organizerAccount.user.organizationId, new Date(Date.now() + 10 * 24 * 60 * 60 * 1000), now, context.adminAccount.id],
    );
    const transfer = await context.fundraisingRepository.requestSurplusTransfer({
      actor: context.organizerAccount.user,
      sourceCampaignId: context.campaignId,
      destinationCampaignId: destinationId,
      amount: "100.00",
      reason: "Surplus funds for another disaster response campaign",
    });
    assert.equal(transfer.status, "REQUESTED");
    const approved = await context.fundraisingRepository.approveSurplusTransfer({ actor: context.adminAccount, transferId: transfer.id });
    assert.equal(approved.status, "COMPLETED");
    assert.deepEqual(await context.fundraisingRepository.getCampaignReconciliation({ actor: context.adminAccount, campaignId: context.campaignId }), {
      donations: "100.00", providerFees: "0.00", milestonePayouts: "0.00", refunds: "0.00",
      transfersIn: "0.00", transfersOut: "100.00", platformSupport: "0.00", escrow: "0.00",
    });
    assert.deepEqual(await context.fundraisingRepository.getCampaignReconciliation({ actor: context.adminAccount, campaignId: destinationId }), {
      donations: "0.00", providerFees: "0.00", milestonePayouts: "0.00", refunds: "0.00",
      transfersIn: "100.00", transfersOut: "0.00", platformSupport: "0.00", escrow: "100.00",
    });
  } finally {
    await context.pool.end();
  }
});

test("a verified completed milestone can be paid from escrow through the configured provider", async () => {
  const context = await fixture();
  try {
    const organizerCookie = await login(context.app, "organizer@example.com");
    const milestone = await context.campaignRepository.createMilestone({
      actor: context.organizerAccount.user,
      campaignId: context.campaignId,
      title: "Emergency supplies",
      budgetAmount: "100000.00",
      currency: "IDR",
      orderIndex: 0,
    });
    const donation = await context.fundraisingRepository.createDonation({
      actor: context.funderAccount.user,
      campaignId: context.campaignId,
      amount: "100200.00",
      reallocationPolicy: "REDIRECT_RELATED",
      idempotencyKey: randomUUID(),
      provider: "test-provider",
    });
    await context.fundraisingRepository.attachCheckout({
      donationId: donation.donation.id,
      donorId: context.funderAccount.user.id,
      providerPaymentId: `payment-${donation.donation.id}`,
      checkoutUrl: "https://payments.example/checkout",
    });
    await context.fundraisingRepository.settleDonation({
      provider: "test-provider", providerEventId: "payout-donation", providerEventType: "PAYMENT_SETTLED",
      providerPaymentId: `payment-${donation.donation.id}`, amount: "100200.00", fee: "0.00", currency: "IDR",
    });
    const now = new Date();
    await context.pool.query(
      `UPDATE campaigns SET fundraising_status = 'CLOSED', status = 'ACTIVE', terms_locked_at = $2, terms_commitment = $3 WHERE id = $1`,
      [context.campaignId, now, `0x${"b".repeat(64)}`],
    );
    await context.campaignRepository.updateMilestoneStatus({ actor: context.organizerAccount.user, milestoneId: milestone.id, status: "IN_PROGRESS" });
    await context.campaignRepository.updateMilestoneStatus({ actor: context.organizerAccount.user, milestoneId: milestone.id, status: "COMPLETED" });

    const evidenceId = randomUUID();
    const versionGroupId = randomUUID();
    const reviewRoundId = randomUUID();
    await context.pool.query(
      `INSERT INTO evidence (
        id, milestone_id, uploader_id, evidence_type, storage_key, file_name, content_type, file_size,
        raw_hash, version_group_id, version, previous_evidence_id, status, created_at, updated_at
      ) VALUES ($1, $2, $3, 'RECEIPT', $4, 'proof.pdf', 'application/pdf', 10, $5, $6, 1, NULL, 'READY_FOR_REVIEW', $7, $7)`,
      [evidenceId, milestone.id, context.organizerAccount.user.id, randomUUID(), "a".repeat(64), versionGroupId, now],
    );
    await context.pool.query(
      `INSERT INTO review_rounds (
        id, evidence_id, round_number, review_id, evidence_commitment, organizer_organization_commitment,
        funder_organization_commitment, status, decision, roster_version, created_at, updated_at, completed_at
      ) VALUES ($1, $2, 1, $3, $4, $5, $6, 'QUORUM_REACHED', 'VERIFIED', 1, $7, $7, $7)`,
      [reviewRoundId, evidenceId, `0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`, `0x${"3".repeat(64)}`, `0x${"4".repeat(64)}`, now],
    );
    await context.pool.query(
      `INSERT INTO verifications (id, evidence_id, review_round_id, status, contract_address, transaction_hash, block_number, reviewed_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'VERIFIED', $4, $5, 1, $6, $6, $6)`,
      [randomUUID(), evidenceId, reviewRoundId, `0x${"5".repeat(40)}`, `0x${"6".repeat(64)}`, now],
    );
    await context.fundraisingRepository.setOrganizationPayoutRecipient({
      actor: context.adminAccount,
      organizationId: context.organizerAccount.user.organizationId,
      provider: "test-provider",
      providerRecipientId: "recipient-relief-community",
    });

    const response = await request(context.app)
      .post(`/api/milestones/${milestone.id}/disbursements`)
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", organizerCookie)
      .send({ amount: "100000.00", idempotencyKey: randomUUID() })
      .expect(202);
    assert.equal(response.body.disbursement.status, "PENDING");
    assert.equal(response.body.disbursement.providerFee, "200.00");
    assert.equal("recipient_reference" in response.body.disbursement, false);

    await request(context.app)
      .post("/api/fundraising/webhooks/test-provider")
      .set("x-test-signature", "valid")
      .send({ eventId: "payout-event-1", type: "PAYOUT_SETTLED", payoutId: `payout-${response.body.disbursement.id}`, amount: "100000.00", fee: "200.00", currency: "IDR" })
      .expect(200);
    const payout = await context.pool.query("SELECT status FROM fundraising_disbursements WHERE id = $1", [response.body.disbursement.id]);
    assert.equal(payout.rows[0].status, "PAID");
    assert.deepEqual(await context.fundraisingRepository.getCampaignReconciliation({ actor: context.adminAccount, campaignId: context.campaignId }), {
      donations: "100200.00", providerFees: "200.00", milestonePayouts: "100000.00", refunds: "0.00",
      transfersIn: "0.00", transfersOut: "0.00", platformSupport: "0.00", escrow: "0.00",
    });
  } finally {
    await context.pool.end();
  }
});

test("remaining escrow after all milestones can be allocated back to donors as partial refunds", async () => {
  const context = await fixture();
  try {
    const donation = await context.fundraisingRepository.createDonation({
      actor: context.funderAccount.user,
      campaignId: context.campaignId,
      amount: "100.00",
      reallocationPolicy: "REFUND",
      idempotencyKey: randomUUID(),
      provider: "test-provider",
    });
    await context.fundraisingRepository.attachCheckout({
      donationId: donation.donation.id,
      donorId: context.funderAccount.user.id,
      providerPaymentId: `payment-${donation.donation.id}`,
      checkoutUrl: "https://payments.example/checkout",
    });
    await context.fundraisingRepository.settleDonation({
      provider: "test-provider", providerEventId: "surplus-refund-donation", providerEventType: "PAYMENT_SETTLED",
      providerPaymentId: `payment-${donation.donation.id}`, amount: "100.00", fee: "0.00", currency: "IDR",
    });
    await context.pool.query(
      `INSERT INTO milestones (id, campaign_id, title, description, budget_amount, currency, order_index, status, created_at, updated_at)
       VALUES ($1, $2, 'Aid package', '', '100.00', 'IDR', 0, 'COMPLETED', $3, $3)`,
      [randomUUID(), context.campaignId, new Date()],
    );
    await context.pool.query("UPDATE campaigns SET fundraising_status = 'CLOSED', status = 'ACTIVE' WHERE id = $1", [context.campaignId]);

    const refunds = await context.fundraisingRepository.requestCampaignSurplusRefunds({ actor: context.organizerAccount.user, campaignId: context.campaignId });
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].amount, "100.00");
    await context.fundraisingRepository.attachProviderRefund({ refundId: refunds[0].refundId, providerRefundId: "refund-surplus" });
    await context.fundraisingRepository.settleRefund({
      provider: "test-provider", providerEventId: "surplus-refund-settled", providerEventType: "REFUND_SETTLED",
      providerRefundId: "refund-surplus", amount: "100.00", currency: "IDR",
    });
    assert.deepEqual(await context.fundraisingRepository.getCampaignReconciliation({ actor: context.adminAccount, campaignId: context.campaignId }), {
      donations: "100.00", providerFees: "0.00", milestonePayouts: "0.00", refunds: "100.00",
      transfersIn: "0.00", transfersOut: "0.00", platformSupport: "0.00", escrow: "0.00",
    });
  } finally {
    await context.pool.end();
  }
});
