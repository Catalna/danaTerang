import { randomUUID } from "node:crypto";

import { decimalAmount, escrowBalance, minorUnits, reconcileCampaignLedger } from "./ledger.js";

function failure(code, message = code) {
  return Object.assign(new Error(message), { code });
}

async function inTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally {
    client.release();
  }
}

function donationFromRow(row) {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    donorId: row.donor_user_id,
    amount: decimalAmount(minorUnits(String(row.gross_amount))),
    providerFee: decimalAmount(minorUnits(String(row.provider_fee))),
    netAmount: decimalAmount(minorUnits(String(row.net_amount))),
    currency: row.currency,
    reallocationPolicy: row.reallocation_policy,
    status: row.status,
    checkoutUrl: row.checkout_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
  };
}

function transferFromRow(row) {
  return {
    id: row.id,
    sourceCampaignId: row.source_campaign_id,
    destinationCampaignId: row.destination_campaign_id,
    amount: decimalAmount(minorUnits(String(row.amount))),
    currency: row.currency,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function availableEscrow(client, campaignId) {
  const result = await client.query(
    `SELECT transaction_id AS "transactionId", account, entry_side AS "entrySide", amount::text AS amount, currency
     FROM fundraising_ledger_entries WHERE campaign_id = $1 AND account = 'ESCROW'`,
    [campaignId],
  );
  return escrowBalance(result.rows);
}

async function fundraisingProjection(queryable, campaignId, now) {
  const result = await queryable.query(
    `SELECT id, organization_id, title, description, cause_category, total_budget, currency,
            status, fundraising_status, fundraising_close_at, amendment_count,
            terms_locked_at, publicly_published_at
     FROM campaigns
     WHERE id = $1 LIMIT 1`,
    [campaignId],
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  if (row.publicly_published_at == null || !["OPEN", "LOCKED"].includes(row.fundraising_status)) return null;
  if (!row.fundraising_close_at || new Date(row.fundraising_close_at) <= now) return null;
  const organizationResult = await queryable.query("SELECT name FROM organizations WHERE id = $1 LIMIT 1", [row.organization_id]);
  const raisedResult = await queryable.query(
    `SELECT COALESCE(SUM(CASE WHEN status = 'PAID' THEN gross_amount ELSE 0 END), 0)::text AS gross_raised,
            COUNT(CASE WHEN status = 'PAID' THEN 1 END)::int AS donation_count
     FROM fundraising_donations WHERE campaign_id = $1`,
    [campaignId],
  );
  const raisedRow = raisedResult.rows[0];
  const raised = minorUnits(String(raisedRow.gross_raised));
  const target = minorUnits(String(row.total_budget));
  const milestoneRows = await queryable.query(
    `SELECT id, title, description, budget_amount, currency, order_index, status
     FROM milestones WHERE campaign_id = $1 ORDER BY order_index ASC, id ASC`,
    [campaignId],
  );
  const ledgerRows = await queryable.query(
    `SELECT transaction_id AS "transactionId", account, entry_side AS "entrySide", amount::text AS amount, currency
     FROM fundraising_ledger_entries WHERE campaign_id = $1`,
    [campaignId],
  );
  const availableBalance = escrowBalance(ledgerRows.rows);
  const providerFees = ledgerRows.rows.reduce((sum, entry) =>
    sum + (entry.account === "PROVIDER_FEES" && entry.entrySide === "DEBIT" ? minorUnits(String(entry.amount)) : 0n), 0n);
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: organizationResult.rows[0]?.name ?? null,
    title: row.title,
    description: row.description,
    causeCategory: row.cause_category,
    fundraisingTarget: decimalAmount(target),
    grossRaised: decimalAmount(raised),
    providerFees: decimalAmount(providerFees),
    escrowBalance: decimalAmount(availableBalance),
    donorCount: Number(raisedRow.donation_count),
    goalPercent: target === 0n ? 0 : Number((raised * 100n) / target),
    currency: row.currency,
    fundraisingStatus: row.fundraising_status,
    closeAt: row.fundraising_close_at,
    acceptingDonations: row.fundraising_status === "LOCKED"
      || now.getTime() < new Date(row.fundraising_close_at).getTime() - 48 * 60 * 60 * 1000,
    termsLockedAt: row.terms_locked_at,
    amendmentsUsed: Number(row.amendment_count),
    milestones: milestoneRows.rows.map((milestone) => ({
      id: milestone.id,
      title: milestone.title,
      description: milestone.description,
      budgetAmount: decimalAmount(minorUnits(String(milestone.budget_amount))),
      currency: milestone.currency,
      orderIndex: milestone.order_index,
      status: milestone.status,
    })),
  };
}

export function createFundraisingRepository(pool) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("A PostgreSQL-compatible pool is required");
  }

  return Object.freeze({
    async listOpenCampaigns({ now = new Date() } = {}) {
      const ids = await pool.query(
        `SELECT id FROM campaigns
         WHERE fundraising_close_at IS NOT NULL
         ORDER BY fundraising_close_at ASC, created_at DESC, id ASC`,
        [],
      );
      const campaigns = [];
      for (const row of ids.rows) {
        const campaign = await fundraisingProjection(pool, row.id, now);
        if (campaign) campaigns.push(campaign);
      }
      return campaigns;
    },

    async getOpenCampaign(campaignId, { now = new Date() } = {}) {
      return fundraisingProjection(pool, campaignId, now);
    },

    async createDonation({ actor, campaignId, amount, reallocationPolicy, idempotencyKey, provider, now = new Date() }) {
      if (actor?.role !== "FUNDER") throw failure("FORBIDDEN");
      const amountUnits = minorUnits(amount);
      if (amountUnits <= 0n) throw failure("INVALID_AMOUNT");
      if (!["REDIRECT_RELATED", "REFUND"].includes(reallocationPolicy)) throw failure("INVALID_REALLOCATION_POLICY");

      return inTransaction(pool, async (client) => {
        const campaignResult = await client.query(
          `SELECT id, total_budget, currency, fundraising_status, fundraising_close_at,
                  publicly_published_at, title, organization_id
           FROM campaigns WHERE id = $1 LIMIT 1 FOR UPDATE`,
          [campaignId],
        );
        if (!campaignResult.rowCount) throw failure("CAMPAIGN_NOT_FOUND");
        const campaign = campaignResult.rows[0];
        if (campaign.publicly_published_at == null || !["OPEN", "LOCKED"].includes(campaign.fundraising_status)
            || !campaign.fundraising_close_at || new Date(campaign.fundraising_close_at) <= now) {
          throw failure("FUNDRAISING_CLOSED");
        }
        if (campaign.fundraising_status === "OPEN"
            && now.getTime() >= new Date(campaign.fundraising_close_at).getTime() - 48 * 60 * 60 * 1000) {
          throw failure("CAMPAIGN_TERMS_REQUIRED");
        }
        if (campaign.currency !== "IDR") throw failure("UNSUPPORTED_CURRENCY");

        const previous = await client.query(
          `SELECT * FROM fundraising_donations WHERE donor_user_id = $1 AND idempotency_key = $2 LIMIT 1`,
          [actor.id, idempotencyKey],
        );
        if (previous.rowCount) {
          const row = previous.rows[0];
          if (row.campaign_id !== campaignId || minorUnits(String(row.gross_amount)) !== amountUnits
              || row.reallocation_policy !== reallocationPolicy) throw failure("DONATION_IDEMPOTENCY_CONFLICT");
          return { donation: donationFromRow(row), campaignTitle: campaign.title, organizationId: campaign.organization_id, created: false };
        }

        const id = randomUUID();
        const result = await client.query(
          `INSERT INTO fundraising_donations (
             id, campaign_id, donor_user_id, provider, idempotency_key, gross_amount,
             currency, reallocation_policy, status, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'IDR', $7, 'PENDING', $8, $8)
           RETURNING *`,
          [id, campaignId, actor.id, provider, idempotencyKey, amount, reallocationPolicy, now],
        );
        return { donation: donationFromRow(result.rows[0]), campaignTitle: campaign.title, organizationId: campaign.organization_id, created: true };
      });
    },

    async attachCheckout({ donationId, donorId, providerPaymentId, checkoutUrl, now = new Date() }) {
      const result = await pool.query(
        `UPDATE fundraising_donations SET provider_payment_id = $3, checkout_url = $4, updated_at = $5
         WHERE id = $1 AND donor_user_id = $2
           AND (status = 'PENDING' OR (status = 'FAILED' AND campaign_id IN (
             SELECT id FROM campaigns WHERE fundraising_status = 'CANCELLED'
           )))
         RETURNING *`,
        [donationId, donorId, providerPaymentId, checkoutUrl, now],
      );
      if (!result.rowCount) throw failure("DONATION_NOT_PENDING");
      return donationFromRow(result.rows[0]);
    },

    async settleDonation({ provider, providerEventId, providerEventType, providerPaymentId, amount, fee, currency, now = new Date() }) {
      const amountUnits = minorUnits(amount);
      const feeUnits = minorUnits(fee);
      if (currency !== "IDR" || feeUnits >= amountUnits) throw failure("INVALID_PROVIDER_SETTLEMENT");
      return inTransaction(pool, async (client) => {
        const seen = await client.query(
          "SELECT id FROM fundraising_provider_events WHERE provider = $1 AND provider_event_id = $2 LIMIT 1",
          [provider, providerEventId],
        );
        if (seen.rowCount) return { duplicate: true };
        const result = await client.query(
          `SELECT d.*, c.fundraising_status FROM fundraising_donations d
           JOIN campaigns c ON c.id = d.campaign_id
           WHERE d.provider = $1 AND d.provider_payment_id = $2 LIMIT 1 FOR UPDATE`,
          [provider, providerPaymentId],
        );
        if (!result.rowCount) throw failure("DONATION_NOT_FOUND");
        const donation = result.rows[0];
        if (donation.status === "PAID") {
          await client.query(
            `INSERT INTO fundraising_provider_events (id, provider, provider_event_id, provider_event_type, donation_id, received_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [randomUUID(), provider, providerEventId, providerEventType, donation.id, now],
          );
          return { donation: donationFromRow(donation), duplicate: true };
        }
        const refundLatePayment = donation.status === "FAILED" && donation.fundraising_status === "CANCELLED";
        if ((donation.status !== "PENDING" && !refundLatePayment) || minorUnits(String(donation.gross_amount)) !== amountUnits) {
          throw failure("DONATION_SETTLEMENT_MISMATCH");
        }
        const netUnits = amountUnits - feeUnits;
        const netAmount = decimalAmount(netUnits);
        const ledgerTransactionId = randomUUID();
        await client.query(
          `INSERT INTO fundraising_provider_events (id, provider, provider_event_id, provider_event_type, donation_id, received_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), provider, providerEventId, providerEventType, donation.id, now],
        );
        await client.query(
          `INSERT INTO fundraising_ledger_transactions (
             id, campaign_id, transaction_type, reference_type, reference_id, idempotency_key, created_by, created_at
           ) VALUES ($1, $2, 'DONATION_SETTLED', 'DONATION', $3, $4, $5, $6)`,
          [ledgerTransactionId, donation.campaign_id, donation.id, `donation-settled:${donation.id}`, donation.donor_user_id, now],
        );
        const entries = [
          ["PAYMENT_CLEARING", "DEBIT", amount],
          ["DONATIONS", "CREDIT", amount],
          ["PROVIDER_FEES", "DEBIT", decimalAmount(feeUnits)],
          ["PAYMENT_CLEARING", "CREDIT", decimalAmount(feeUnits)],
          ["ESCROW", "DEBIT", netAmount],
          ["PAYMENT_CLEARING", "CREDIT", netAmount],
        ].filter(([, , entryAmount]) => minorUnits(entryAmount) > 0n);
        for (const [account, entrySide, entryAmount] of entries) {
          await client.query(
            `INSERT INTO fundraising_ledger_entries (id, transaction_id, campaign_id, account, entry_side, amount, currency, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'IDR', $7)`,
            [randomUUID(), ledgerTransactionId, donation.campaign_id, account, entrySide, entryAmount, now],
          );
        }
        if (refundLatePayment) {
          await client.query(
            `INSERT INTO fundraising_refunds (id, donation_id, provider, amount, reason, status, created_at, updated_at)
             VALUES ($1, $2, $3, $4, 'CAMPAIGN_TERMS_UNSIGNED', 'PENDING', $5, $5)
             ON CONFLICT (donation_id) DO NOTHING`,
            [randomUUID(), donation.id, provider, donation.gross_amount, now],
          );
        }
        const updated = await client.query(
          `UPDATE fundraising_donations SET status = $5, provider_fee = $2, net_amount = $3,
             settled_at = $4, updated_at = $4 WHERE id = $1 RETURNING *`,
          [donation.id, decimalAmount(feeUnits), netAmount, now, refundLatePayment ? "REFUND_PENDING" : "PAID"],
        );
        return { donation: donationFromRow(updated.rows[0]), duplicate: false };
      });
    },

    async failDonation({ provider, providerEventId, providerEventType, providerPaymentId, now = new Date() }) {
      return inTransaction(pool, async (client) => {
        const seen = await client.query(
          "SELECT id FROM fundraising_provider_events WHERE provider = $1 AND provider_event_id = $2 LIMIT 1",
          [provider, providerEventId],
        );
        if (seen.rowCount) return { duplicate: true };
        const result = await client.query(
          `SELECT * FROM fundraising_donations WHERE provider = $1 AND provider_payment_id = $2 LIMIT 1 FOR UPDATE`,
          [provider, providerPaymentId],
        );
        if (!result.rowCount) throw failure("DONATION_NOT_FOUND");
        const donation = result.rows[0];
        await client.query(
          `INSERT INTO fundraising_provider_events (id, provider, provider_event_id, provider_event_type, donation_id, received_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), provider, providerEventId, providerEventType, donation.id, now],
        );
        if (donation.status === "PENDING") {
          await client.query("UPDATE fundraising_donations SET status = 'FAILED', updated_at = $2 WHERE id = $1", [donation.id, now]);
        }
        return { duplicate: false };
      });
    },

    async createDisbursementRequest({ actor, milestoneId, amount, providerFee = "0.00", idempotencyKey, provider, now = new Date() }) {
      if (actor?.role !== "ORGANIZER" || !actor.organizationId) throw failure("FORBIDDEN");
      const amountUnits = minorUnits(amount);
      const feeUnits = minorUnits(providerFee);
      if (amountUnits <= 0n) throw failure("INVALID_AMOUNT");
      return inTransaction(pool, async (client) => {
        const context = await client.query(
          `SELECT m.id AS milestone_id, m.budget_amount, m.currency AS milestone_currency, m.status AS milestone_status,
                  c.id AS campaign_id, c.organization_id, c.status AS campaign_status,
                  c.fundraising_status, c.currency AS campaign_currency
           FROM milestones m JOIN campaigns c ON c.id = m.campaign_id
           WHERE m.id = $1 AND c.organization_id = $2 LIMIT 1 FOR UPDATE`,
          [milestoneId, actor.organizationId],
        );
        if (!context.rowCount) throw failure("MILESTONE_NOT_FOUND");
        const milestone = context.rows[0];
        if (milestone.fundraising_status !== "CLOSED" || !["ACTIVE", "COMPLETED"].includes(milestone.campaign_status)) {
          throw failure("CAMPAIGN_NOT_CLOSED");
        }
        if (milestone.milestone_status !== "COMPLETED") throw failure("MILESTONE_NOT_COMPLETED");
        if (milestone.milestone_currency !== "IDR" || milestone.campaign_currency !== "IDR") throw failure("UNSUPPORTED_CURRENCY");
        const verified = await client.query(
          `SELECT e.id FROM evidence e JOIN verifications v ON v.evidence_id = e.id
           WHERE e.milestone_id = $1 AND e.status <> 'SUPERSEDED' AND v.status = 'VERIFIED' LIMIT 1`,
          [milestoneId],
        );
        if (!verified.rowCount) throw failure("MILESTONE_NOT_VERIFIED");
        const recipient = await client.query(
          `SELECT provider_recipient_id FROM organization_payout_recipients
           WHERE organization_id = $1 AND provider = $2 AND status = 'ACTIVE' LIMIT 1`,
          [actor.organizationId, provider],
        );
        if (!recipient.rowCount) throw failure("PAYOUT_RECIPIENT_NOT_READY");
        const previous = await client.query(
          "SELECT * FROM fundraising_disbursements WHERE requested_by = $1 AND idempotency_key = $2 LIMIT 1",
          [actor.id, idempotencyKey],
        );
        if (previous.rowCount) {
          const row = previous.rows[0];
          if (row.milestone_id !== milestoneId || minorUnits(String(row.amount)) !== amountUnits
              || minorUnits(String(row.provider_fee)) !== feeUnits) throw failure("DISBURSEMENT_IDEMPOTENCY_CONFLICT");
          return { disbursement: row, created: false };
        }
        const used = await client.query(
          `SELECT amount::text AS amount FROM fundraising_disbursements
           WHERE milestone_id = $1 AND status IN ('PENDING', 'PAID')`,
          [milestoneId],
        );
        const spent = used.rows.reduce((sum, row) => sum + minorUnits(String(row.amount)), 0n);
        if (spent + amountUnits > minorUnits(String(milestone.budget_amount))) throw failure("DISBURSEMENT_BUDGET_EXCEEDED");
        const balance = await availableEscrow(client, milestone.campaign_id);
        const reserved = await client.query(
          `SELECT amount::text AS amount, provider_fee::text AS provider_fee FROM fundraising_disbursements
           WHERE campaign_id = $1 AND status = 'PENDING'`,
          [milestone.campaign_id],
        );
        const reservedUnits = reserved.rows.reduce((sum, row) => sum + minorUnits(String(row.amount)) + minorUnits(String(row.provider_fee)), 0n);
        if (amountUnits + feeUnits > balance - reservedUnits) throw failure("ESCROW_INSUFFICIENT");
        const result = await client.query(
          `INSERT INTO fundraising_disbursements (
             id, campaign_id, milestone_id, requested_by, provider, idempotency_key,
             amount, provider_fee, currency, status, recipient_reference, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'IDR', 'PENDING', $9, $10, $10) RETURNING *`,
          [randomUUID(), milestone.campaign_id, milestoneId, actor.id, provider, idempotencyKey, amount, providerFee, recipient.rows[0].provider_recipient_id, now],
        );
        return { disbursement: result.rows[0], created: true };
      });
    },

    async attachPayout({ disbursementId, providerPayoutId, now = new Date() }) {
      const result = await pool.query(
        `UPDATE fundraising_disbursements SET provider_payout_id = $2, updated_at = $3
         WHERE id = $1 AND status = 'PENDING' RETURNING *`,
        [disbursementId, providerPayoutId, now],
      );
      if (!result.rowCount) throw failure("DISBURSEMENT_NOT_PENDING");
      return result.rows[0];
    },

    async failDisbursement({ provider, providerEventId, providerEventType, providerPayoutId, now = new Date() }) {
      return inTransaction(pool, async (client) => {
        const seen = await client.query(
          "SELECT id FROM fundraising_provider_events WHERE provider = $1 AND provider_event_id = $2 LIMIT 1",
          [provider, providerEventId],
        );
        if (seen.rowCount) return { duplicate: true };
        const result = await client.query(
          `SELECT * FROM fundraising_disbursements WHERE provider = $1 AND provider_payout_id = $2 LIMIT 1 FOR UPDATE`,
          [provider, providerPayoutId],
        );
        if (!result.rowCount) throw failure("DISBURSEMENT_NOT_FOUND");
        const disbursement = result.rows[0];
        if (disbursement.status !== "PENDING") return { duplicate: true };
        await client.query(
          `INSERT INTO fundraising_provider_events (id, provider, provider_event_id, provider_event_type, disbursement_id, received_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), provider, providerEventId, providerEventType, disbursement.id, now],
        );
        await client.query(
          `UPDATE fundraising_disbursements SET status = 'FAILED', updated_at = $2 WHERE id = $1`,
          [disbursement.id, now],
        );
        return { duplicate: false, disbursementId: disbursement.id };
      });
    },

    async settleDisbursement({ provider, providerEventId, providerEventType, providerPayoutId, amount: settledAmount, fee: settledFee, currency, now = new Date() }) {
      return inTransaction(pool, async (client) => {
        const seen = await client.query(
          "SELECT id FROM fundraising_provider_events WHERE provider = $1 AND provider_event_id = $2 LIMIT 1",
          [provider, providerEventId],
        );
        if (seen.rowCount) return { duplicate: true };
        const result = await client.query(
          `SELECT * FROM fundraising_disbursements WHERE provider = $1 AND provider_payout_id = $2 LIMIT 1 FOR UPDATE`,
          [provider, providerPayoutId],
        );
        if (!result.rowCount) throw failure("DISBURSEMENT_NOT_FOUND");
        const disbursement = result.rows[0];
        if (disbursement.status === "PAID") return { duplicate: true };
        if (disbursement.status !== "PENDING") throw failure("DISBURSEMENT_NOT_PENDING");
        if (currency !== "IDR" || minorUnits(String(settledAmount)) !== minorUnits(String(disbursement.amount))
            || minorUnits(String(settledFee)) !== minorUnits(String(disbursement.provider_fee))) {
          throw failure("DISBURSEMENT_AMOUNT_MISMATCH");
        }
        await client.query(
          `INSERT INTO fundraising_provider_events (id, provider, provider_event_id, provider_event_type, disbursement_id, received_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), provider, providerEventId, providerEventType, disbursement.id, now],
        );
        const amount = minorUnits(String(disbursement.amount));
        const fee = minorUnits(String(disbursement.provider_fee));
        const ledgerTransactionId = randomUUID();
        await client.query(
          `INSERT INTO fundraising_ledger_transactions (
             id, campaign_id, transaction_type, reference_type, reference_id, idempotency_key, created_by, created_at
           ) VALUES ($1, $2, 'MILESTONE_PAYOUT', 'DISBURSEMENT', $3, $4, $5, $6)`,
          [ledgerTransactionId, disbursement.campaign_id, disbursement.id, `payout:${disbursement.id}`, disbursement.requested_by, now],
        );
        for (const [account, side, entryAmount] of [
          ["MILESTONE_PAYOUTS", "DEBIT", amount],
          ["PROVIDER_FEES", "DEBIT", fee],
          ["ESCROW", "CREDIT", amount + fee],
        ].filter(([, , value]) => value > 0n)) {
          await client.query(
            `INSERT INTO fundraising_ledger_entries (id, transaction_id, campaign_id, account, entry_side, amount, currency, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'IDR', $7)`,
            [randomUUID(), ledgerTransactionId, disbursement.campaign_id, account, side, decimalAmount(entryAmount), now],
          );
        }
        await client.query(
          `UPDATE fundraising_disbursements SET status = 'PAID', settled_at = $2, updated_at = $2 WHERE id = $1`,
          [disbursement.id, now],
        );
        return { duplicate: false, disbursementId: disbursement.id };
      });
    },

    async listPendingRefunds({ limit = 50 } = {}) {
      const result = await pool.query(
        `SELECT r.id, r.donation_id, r.provider, r.provider_refund_id, r.amount::text AS amount,
                r.currency, d.provider_payment_id
         FROM fundraising_refunds r JOIN fundraising_donations d ON d.id = r.donation_id
         WHERE r.status = 'PENDING' ORDER BY r.created_at ASC, r.id ASC LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => ({
        id: row.id,
        donationId: row.donation_id,
        provider: row.provider,
        providerRefundId: row.provider_refund_id,
        providerPaymentId: row.provider_payment_id,
        amount: decimalAmount(minorUnits(String(row.amount))),
        currency: row.currency,
      }));
    },

    async attachProviderRefund({ refundId, providerRefundId, now = new Date() }) {
      const result = await pool.query(
        `UPDATE fundraising_refunds SET provider_refund_id = $2, updated_at = $3
         WHERE id = $1 AND status = 'PENDING' RETURNING id`,
        [refundId, providerRefundId, now],
      );
      if (!result.rowCount) throw failure("REFUND_NOT_PENDING");
      return result.rows[0];
    },

    async settleRefund({ provider, providerEventId, providerEventType, providerRefundId, amount: settledAmount, currency, now = new Date() }) {
      return inTransaction(pool, async (client) => {
        const seen = await client.query(
          "SELECT id FROM fundraising_provider_events WHERE provider = $1 AND provider_event_id = $2 LIMIT 1",
          [provider, providerEventId],
        );
        if (seen.rowCount) return { duplicate: true };
        const result = await client.query(
          `SELECT r.*, d.campaign_id, d.provider_fee, d.net_amount
           FROM fundraising_refunds r JOIN fundraising_donations d ON d.id = r.donation_id
           WHERE r.provider = $1 AND r.provider_refund_id = $2 LIMIT 1 FOR UPDATE`,
          [provider, providerRefundId],
        );
        if (!result.rowCount) throw failure("REFUND_NOT_FOUND");
        const refund = result.rows[0];
        if (refund.status === "COMPLETED") return { duplicate: true };
        const amount = minorUnits(String(refund.amount));
        const fee = minorUnits(String(refund.fee_subsidy));
        const net = amount - fee;
        if (currency !== "IDR" || minorUnits(String(settledAmount)) !== amount || net + fee !== amount) throw failure("REFUND_AMOUNT_MISMATCH");
        await client.query(
          `INSERT INTO fundraising_provider_events (id, provider, provider_event_id, provider_event_type, refund_id, received_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), provider, providerEventId, providerEventType, refund.id, now],
        );
        const ledgerTransactionId = randomUUID();
        await client.query(
          `INSERT INTO fundraising_ledger_transactions (
             id, campaign_id, transaction_type, reference_type, reference_id, idempotency_key, created_at
           ) VALUES ($1, $2, 'REFUND', 'REFUND', $3, $4, $5)`,
          [ledgerTransactionId, refund.campaign_id, refund.id, `refund-completed:${refund.id}`, now],
        );
        const entries = [
          ["REFUNDS", "DEBIT", amount],
          ["ESCROW", "CREDIT", net],
          ["PLATFORM_SUPPORT", "CREDIT", fee],
        ].filter(([, , value]) => value > 0n);
        for (const [account, entrySide, value] of entries) {
          await client.query(
            `INSERT INTO fundraising_ledger_entries (id, transaction_id, campaign_id, account, entry_side, amount, currency, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'IDR', $7)`,
            [randomUUID(), ledgerTransactionId, refund.campaign_id, account, entrySide, decimalAmount(value), now],
          );
        }
        await client.query(
          `UPDATE fundraising_refunds SET status = 'COMPLETED', settled_at = $2, updated_at = $2 WHERE id = $1`,
          [refund.id, now],
        );
        await client.query(
          `UPDATE fundraising_donations SET status = 'REFUNDED', updated_at = $2 WHERE id = $1`,
          [refund.donation_id, now],
        );
        return { duplicate: false, refundId: refund.id };
      });
    },

    async failRefund({ provider, providerEventId, providerEventType, providerRefundId, now = new Date() }) {
      return inTransaction(pool, async (client) => {
        const seen = await client.query(
          "SELECT id FROM fundraising_provider_events WHERE provider = $1 AND provider_event_id = $2 LIMIT 1",
          [provider, providerEventId],
        );
        if (seen.rowCount) return { duplicate: true };
        const result = await client.query(
          `SELECT id FROM fundraising_refunds WHERE provider = $1 AND provider_refund_id = $2 LIMIT 1 FOR UPDATE`,
          [provider, providerRefundId],
        );
        if (!result.rowCount) throw failure("REFUND_NOT_FOUND");
        const refundId = result.rows[0].id;
        await client.query(
          `INSERT INTO fundraising_provider_events (id, provider, provider_event_id, provider_event_type, refund_id, received_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), provider, providerEventId, providerEventType, refundId, now],
        );
        await client.query(
          `UPDATE fundraising_refunds SET provider_refund_id = NULL, updated_at = $2
           WHERE id = $1 AND status = 'PENDING'`,
          [refundId, now],
        );
        return { duplicate: false, refundId };
      });
    },

    async listDonationsForUser(donorId) {
      const result = await pool.query(
        `SELECT d.*, c.title AS campaign_title FROM fundraising_donations d
         JOIN campaigns c ON c.id = d.campaign_id WHERE d.donor_user_id = $1
         ORDER BY d.created_at DESC, d.id ASC`,
        [donorId],
      );
      return result.rows.map((row) => ({ ...donationFromRow(row), campaignTitle: row.campaign_title }));
    },

    async getDonationForUser({ donorId, donationId }) {
      const result = await pool.query(
        "SELECT * FROM fundraising_donations WHERE id = $1 AND donor_user_id = $2 LIMIT 1",
        [donationId, donorId],
      );
      if (!result.rowCount) throw failure("DONATION_NOT_FOUND");
      return { ...donationFromRow(result.rows[0]), providerPaymentId: result.rows[0].provider_payment_id };
    },

    async getCampaignReconciliation({ actor, campaignId }) {
      if (!new Set(["ADMIN", "ORGANIZER"]).has(actor?.role)) throw failure("FORBIDDEN");
      const campaign = await pool.query("SELECT id, organization_id FROM campaigns WHERE id = $1 LIMIT 1", [campaignId]);
      if (!campaign.rowCount) throw failure("CAMPAIGN_NOT_FOUND");
      if (actor.role === "ORGANIZER" && actor.organizationId !== campaign.rows[0].organization_id) throw failure("FORBIDDEN");
      const result = await pool.query(
        `SELECT transaction_id AS "transactionId", account, entry_side AS "entrySide", amount::text AS amount, currency
         FROM fundraising_ledger_entries WHERE campaign_id = $1 ORDER BY created_at ASC, id ASC`,
        [campaignId],
      );
      return reconcileCampaignLedger(result.rows);
    },

    async listSurplusTransfers({ actor, status = "REQUESTED" }) {
      if (actor?.role !== "ADMIN") throw failure("FORBIDDEN");
      if (!new Set(["REQUESTED", "APPROVED", "COMPLETED", "REJECTED", "ALL"]).has(status)) throw failure("INVALID_TRANSFER_STATUS");
      const where = status === "ALL" ? "TRUE" : "t.status = $1";
      const values = status === "ALL" ? [] : [status];
      const result = await pool.query(
        `SELECT t.*, source.title AS source_title, destination.title AS destination_title,
                source.cause_category AS cause_category
         FROM fundraising_surplus_transfers t
         JOIN campaigns source ON source.id = t.source_campaign_id
         JOIN campaigns destination ON destination.id = t.destination_campaign_id
         WHERE ${where} ORDER BY t.created_at ASC, t.id ASC`,
        values,
      );
      return result.rows.map((row) => ({
        ...transferFromRow(row),
        sourceCampaignTitle: row.source_title,
        destinationCampaignTitle: row.destination_title,
        causeCategory: row.cause_category,
      }));
    },

    async requestSurplusTransfer({ actor, sourceCampaignId, destinationCampaignId, amount, reason, now = new Date() }) {
      if (actor?.role !== "ORGANIZER" || !actor.organizationId) throw failure("FORBIDDEN");
      const amountUnits = minorUnits(amount);
      if (amountUnits <= 0n) throw failure("INVALID_AMOUNT");
      if (typeof reason !== "string" || reason.trim().length < 5 || reason.trim().length > 1000) throw failure("INVALID_TRANSFER_REASON");
      return inTransaction(pool, async (client) => {
        const sourceResult = await client.query(
          `SELECT id, organization_id, fundraising_status, cause_category, currency
           FROM campaigns WHERE id = $1 AND organization_id = $2 LIMIT 1 FOR UPDATE`,
          [sourceCampaignId, actor.organizationId],
        );
        if (!sourceResult.rowCount) throw failure("CAMPAIGN_NOT_FOUND");
        const destinationResult = await client.query(
          `SELECT id, fundraising_status, cause_category, currency
           FROM campaigns WHERE id = $1 LIMIT 1 FOR UPDATE`,
          [destinationCampaignId],
        );
        if (!destinationResult.rowCount) throw failure("DESTINATION_CAMPAIGN_NOT_FOUND");
        const source = sourceResult.rows[0];
        const destination = destinationResult.rows[0];
        if (source.fundraising_status !== "CLOSED") throw failure("SURPLUS_TRANSFER_SOURCE_NOT_CLOSED");
        if (!(["OPEN", "LOCKED"].includes(destination.fundraising_status))) throw failure("SURPLUS_TRANSFER_DESTINATION_NOT_OPEN");
        if (source.cause_category !== destination.cause_category) throw failure("SURPLUS_CAUSE_MISMATCH");
        if (source.currency !== "IDR" || destination.currency !== "IDR") throw failure("UNSUPPORTED_CURRENCY");
        const nonConsentingDonations = await client.query(
          `SELECT id FROM fundraising_donations
           WHERE campaign_id = $1 AND status = 'PAID' AND reallocation_policy <> 'REDIRECT_RELATED' LIMIT 1`,
          [sourceCampaignId],
        );
        if (nonConsentingDonations.rowCount) throw failure("DONOR_CONSENT_REQUIRED");
        const pendingRefunds = await client.query(
          "SELECT id FROM fundraising_refunds WHERE donation_id IN (SELECT id FROM fundraising_donations WHERE campaign_id = $1) AND status = 'PENDING' LIMIT 1",
          [sourceCampaignId],
        );
        if (pendingRefunds.rowCount) throw failure("SURPLUS_REFUNDS_PENDING");
        const balance = await availableEscrow(client, sourceCampaignId);
        const pendingPayouts = await client.query(
          `SELECT amount::text AS amount FROM fundraising_disbursements
           WHERE campaign_id = $1 AND status = 'PENDING'`,
          [sourceCampaignId],
        );
        const reserved = pendingPayouts.rows.reduce((sum, row) => sum + minorUnits(String(row.amount)), 0n);
        if (amountUnits > balance - reserved) throw failure("ESCROW_INSUFFICIENT");

        const result = await client.query(
          `INSERT INTO fundraising_surplus_transfers (
             id, source_campaign_id, destination_campaign_id, requested_by, amount, currency, reason, status, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, 'IDR', $6, 'REQUESTED', $7, $7) RETURNING *`,
          [randomUUID(), sourceCampaignId, destinationCampaignId, actor.id, amount, reason.trim(), now],
        );
        await client.query(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, details, created_at)
           VALUES ($1, $2, 'SURPLUS_TRANSFER_REQUESTED', 'SURPLUS_TRANSFER', $3, $4, $5)`,
          [randomUUID(), actor.id, result.rows[0].id, { sourceCampaignId, destinationCampaignId, amount }, now],
        );
        return transferFromRow(result.rows[0]);
      });
    },

    async requestCampaignSurplusRefunds({ actor, campaignId, now = new Date() }) {
      if (actor?.role !== "ORGANIZER" || !actor.organizationId) throw failure("FORBIDDEN");
      return inTransaction(pool, async (client) => {
        const campaignResult = await client.query(
          `SELECT id, fundraising_status, organization_id, currency FROM campaigns
           WHERE id = $1 AND organization_id = $2 LIMIT 1 FOR UPDATE`,
          [campaignId, actor.organizationId],
        );
        if (!campaignResult.rowCount) throw failure("CAMPAIGN_NOT_FOUND");
        const campaign = campaignResult.rows[0];
        if (campaign.fundraising_status !== "CLOSED") throw failure("SURPLUS_REFUND_CAMPAIGN_NOT_CLOSED");
        const incompleteMilestones = await client.query(
          `SELECT id FROM milestones WHERE campaign_id = $1 AND status NOT IN ('COMPLETED', 'CANCELLED') LIMIT 1`,
          [campaignId],
        );
        if (incompleteMilestones.rowCount) throw failure("SURPLUS_REFUND_MILESTONES_INCOMPLETE");
        const pendingPayouts = await client.query(
          "SELECT id FROM fundraising_disbursements WHERE campaign_id = $1 AND status = 'PENDING' LIMIT 1",
          [campaignId],
        );
        if (pendingPayouts.rowCount) throw failure("SURPLUS_PAYOUTS_PENDING");
        const pendingRefunds = await client.query(
          `SELECT r.id FROM fundraising_refunds r JOIN fundraising_donations d ON d.id = r.donation_id
           WHERE d.campaign_id = $1 AND r.status = 'PENDING' LIMIT 1`,
          [campaignId],
        );
        if (pendingRefunds.rowCount) throw failure("SURPLUS_REFUNDS_PENDING");
        const balance = await availableEscrow(client, campaignId);
        if (balance === 0n) return [];
        const donations = await client.query(
          `SELECT d.id, d.provider, d.gross_amount::text AS gross_amount, d.net_amount::text AS net_amount
           FROM fundraising_donations d LEFT JOIN fundraising_refunds r ON r.donation_id = d.id
           WHERE d.campaign_id = $1 AND d.status = 'PAID' AND r.id IS NULL
           ORDER BY d.id ASC FOR UPDATE`,
          [campaignId],
        );
        const totalWeight = donations.rows.reduce((sum, row) => sum + minorUnits(String(row.net_amount)), 0n);
        if (totalWeight <= 0n || donations.rowCount === 0) throw failure("SURPLUS_REFUND_DONATIONS_NOT_FOUND");
        if (balance > totalWeight) throw failure("SURPLUS_REFUND_TRANSFERRED_FUNDS_REQUIRE_REVIEW");
        const allocations = donations.rows.map((row) => {
          const weight = minorUnits(String(row.net_amount));
          const numerator = balance * weight;
          return { row, weight, amount: numerator / totalWeight, remainder: numerator % totalWeight };
        });
        let allocated = allocations.reduce((sum, item) => sum + item.amount, 0n);
        let centsLeft = balance - allocated;
        allocations.sort((left, right) => left.remainder === right.remainder ? left.row.id.localeCompare(right.row.id) : left.remainder > right.remainder ? -1 : 1);
        for (const allocation of allocations) {
          if (centsLeft === 0n) break;
          if (allocation.amount < allocation.weight) {
            allocation.amount += 1n;
            centsLeft -= 1n;
          }
        }
        if (centsLeft !== 0n) throw failure("SURPLUS_REFUND_ALLOCATION_FAILED");
        allocations.sort((left, right) => left.row.id.localeCompare(right.row.id));
        const refunds = [];
        for (const allocation of allocations) {
          const donation = allocation.row;
          const share = allocation.amount;
          if (share <= 0n) continue;
          const refundId = randomUUID();
          await client.query(
            `INSERT INTO fundraising_refunds (
               id, donation_id, provider, amount, fee_subsidy, reason, status, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, 0, 'CAMPAIGN_SURPLUS_REFUND', 'PENDING', $5, $5)`,
            [refundId, donation.id, donation.provider, decimalAmount(share), now],
          );
          await client.query("UPDATE fundraising_donations SET status = 'REFUND_PENDING', updated_at = $2 WHERE id = $1", [donation.id, now]);
          refunds.push({ refundId, donationId: donation.id, amount: decimalAmount(share) });
        }
        if (allocations.reduce((sum, item) => sum + item.amount, 0n) !== balance) throw failure("SURPLUS_REFUND_ALLOCATION_FAILED");
        await client.query(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, details, created_at)
           VALUES ($1, $2, 'CAMPAIGN_SURPLUS_REFUNDS_REQUESTED', 'CAMPAIGN', $3, $4, $5)`,
          [randomUUID(), actor.id, campaignId, { balance: decimalAmount(balance), refunds: refunds.length }, now],
        );
        return refunds;
      });
    },

    async approveSurplusTransfer({ actor, transferId, now = new Date() }) {
      if (actor?.role !== "ADMIN") throw failure("FORBIDDEN");
      return inTransaction(pool, async (client) => {
        const transferResult = await client.query(
          "SELECT * FROM fundraising_surplus_transfers WHERE id = $1 LIMIT 1 FOR UPDATE",
          [transferId],
        );
        if (!transferResult.rowCount) throw failure("SURPLUS_TRANSFER_NOT_FOUND");
        const transfer = transferResult.rows[0];
        if (transfer.status === "COMPLETED") return transferFromRow(transfer);
        if (transfer.status !== "REQUESTED") throw failure("SURPLUS_TRANSFER_NOT_REQUESTED");
        const campaignIds = [transfer.source_campaign_id, transfer.destination_campaign_id].sort();
        const campaignRows = await client.query(
          `SELECT id, fundraising_status, cause_category, currency
           FROM campaigns WHERE id = $1 OR id = $2 ORDER BY id ASC FOR UPDATE`,
          campaignIds,
        );
        if (campaignRows.rowCount !== 2) throw failure("CAMPAIGN_NOT_FOUND");
        const source = campaignRows.rows.find((row) => row.id === transfer.source_campaign_id);
        const destination = campaignRows.rows.find((row) => row.id === transfer.destination_campaign_id);
        if (source.fundraising_status !== "CLOSED" || !["OPEN", "LOCKED"].includes(destination.fundraising_status)) {
          throw failure("SURPLUS_TRANSFER_STATUS_CHANGED");
        }
        if (source.cause_category !== destination.cause_category) {
          throw failure("SURPLUS_CAUSE_MISMATCH");
        }
        const nonConsentingDonations = await client.query(
          `SELECT id FROM fundraising_donations
           WHERE campaign_id = $1 AND status = 'PAID' AND reallocation_policy <> 'REDIRECT_RELATED' LIMIT 1`,
          [transfer.source_campaign_id],
        );
        if (nonConsentingDonations.rowCount) throw failure("DONOR_CONSENT_REQUIRED");
        const balance = await availableEscrow(client, transfer.source_campaign_id);
        const amount = minorUnits(String(transfer.amount));
        const pendingPayouts = await client.query(
          `SELECT amount::text AS amount FROM fundraising_disbursements
           WHERE campaign_id = $1 AND status = 'PENDING'`,
          [transfer.source_campaign_id],
        );
        const reserved = pendingPayouts.rows.reduce((sum, row) => sum + minorUnits(String(row.amount)), 0n);
        if (amount > balance - reserved) throw failure("ESCROW_INSUFFICIENT");

        for (const [campaignId, transactionType, account, side, idempotencyKey] of [
          [transfer.source_campaign_id, "SURPLUS_TRANSFER_OUT", "CAUSE_TRANSFERS", "DEBIT", `surplus-out:${transfer.id}`],
          [transfer.destination_campaign_id, "SURPLUS_TRANSFER_IN", "CAUSE_TRANSFERS", "CREDIT", `surplus-in:${transfer.id}`],
        ]) {
          const transactionId = randomUUID();
          await client.query(
            `INSERT INTO fundraising_ledger_transactions (
               id, campaign_id, transaction_type, reference_type, reference_id, idempotency_key, created_by, created_at
             ) VALUES ($1, $2, $3, 'TRANSFER', $4, $5, $6, $7)`,
            [transactionId, campaignId, transactionType, transfer.id, idempotencyKey, actor.id, now],
          );
          await client.query(
            `INSERT INTO fundraising_ledger_entries (id, transaction_id, campaign_id, account, entry_side, amount, currency, created_at)
             VALUES ($1, $2, $3, 'ESCROW', $4, $5, 'IDR', $6), ($7, $2, $3, 'CAUSE_TRANSFERS', $8, $5, 'IDR', $6)`,
            [randomUUID(), transactionId, campaignId, transactionType === "SURPLUS_TRANSFER_OUT" ? "CREDIT" : "DEBIT", decimalAmount(amount), now,
              randomUUID(), side],
          );
        }
        const completed = await client.query(
          `UPDATE fundraising_surplus_transfers SET status = 'COMPLETED', approved_by = $2, updated_at = $3 WHERE id = $1 RETURNING *`,
          [transferId, actor.id, now],
        );
        await client.query(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, details, created_at)
           VALUES ($1, $2, 'SURPLUS_TRANSFER_COMPLETED', 'SURPLUS_TRANSFER', $3, $4, $5)`,
          [randomUUID(), actor.id, transferId, { sourceCampaignId: transfer.source_campaign_id, destinationCampaignId: transfer.destination_campaign_id, amount: decimalAmount(amount) }, now],
        );
        return transferFromRow(completed.rows[0]);
      });
    },

    async setOrganizationPayoutRecipient({ actor, organizationId, provider, providerRecipientId, now = new Date() }) {
      if (actor?.role !== "ADMIN") throw failure("FORBIDDEN");
      return inTransaction(pool, async (client) => {
        const organization = await client.query("SELECT id, name FROM organizations WHERE id = $1 LIMIT 1", [organizationId]);
        if (!organization.rowCount) throw failure("ORGANIZATION_NOT_FOUND");
        const result = await client.query(
          `INSERT INTO organization_payout_recipients (
             id, organization_id, provider, provider_recipient_id, status, created_by, verified_by, verified_at, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $5, $6, $6, $6)
           ON CONFLICT (organization_id, provider) DO UPDATE SET
             provider_recipient_id = EXCLUDED.provider_recipient_id, status = 'ACTIVE',
             verified_by = EXCLUDED.verified_by, verified_at = EXCLUDED.verified_at, updated_at = EXCLUDED.updated_at
           RETURNING id, organization_id, provider, status, verified_at, updated_at`,
          [randomUUID(), organizationId, provider, providerRecipientId, actor.id, now],
        );
        await client.query(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, details, created_at)
           VALUES ($1, $2, 'ORGANIZATION_PAYOUT_RECIPIENT_VERIFIED', 'ORGANIZATION', $3, $4, $5)`,
          [randomUUID(), actor.id, organizationId, { provider: result.rows[0].provider, status: result.rows[0].status }, now],
        );
        return {
          id: result.rows[0].id,
          organizationId: result.rows[0].organization_id,
          provider: result.rows[0].provider,
          status: result.rows[0].status,
          verifiedAt: result.rows[0].verified_at,
          updatedAt: result.rows[0].updated_at,
        };
      });
    },

    async processFundraisingDeadlines({ now = new Date(), signatureGraceMs = 120_000 } = {}) {
      const campaigns = await pool.query(
        `SELECT id, organization_id, status, fundraising_status, fundraising_close_at, terms_locked_at
         FROM campaigns WHERE fundraising_status IN ('OPEN', 'LOCKED')`,
      );
      const cancelledCampaignIds = [];
      const closedCampaignIds = [];
      const refundIds = [];
      for (const campaign of campaigns.rows) {
        const closeAt = campaign.fundraising_close_at ? new Date(campaign.fundraising_close_at) : null;
        if (!closeAt || !Number.isFinite(closeAt.getTime())) continue;
        if (campaign.fundraising_status === "OPEN"
            && campaign.terms_locked_at == null
            && now.getTime() >= closeAt.getTime() - 48 * 60 * 60 * 1000 + signatureGraceMs) {
          const result = await inTransaction(pool, async (client) => {
            const locked = await client.query(
              `SELECT id, organization_id, fundraising_status, terms_locked_at
               FROM campaigns WHERE id = $1 LIMIT 1 FOR UPDATE`,
              [campaign.id],
            );
            if (!locked.rowCount || locked.rows[0].fundraising_status !== "OPEN" || locked.rows[0].terms_locked_at != null) return [];
            const paid = await client.query(
              `SELECT id, provider, gross_amount, provider_fee FROM fundraising_donations
               WHERE campaign_id = $1 AND status = 'PAID' FOR UPDATE`,
              [campaign.id],
            );
            const createdRefunds = [];
            for (const donation of paid.rows) {
              const refundId = randomUUID();
              await client.query(
                `INSERT INTO fundraising_refunds (id, donation_id, provider, amount, fee_subsidy, reason, status, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, 'CAMPAIGN_TERMS_UNSIGNED', 'PENDING', $6, $6)
                 ON CONFLICT (donation_id) DO UPDATE SET
                   amount = EXCLUDED.amount, fee_subsidy = EXCLUDED.fee_subsidy, updated_at = EXCLUDED.updated_at`,
                [refundId, donation.id, donation.provider, donation.gross_amount, donation.provider_fee, now],
              );
              await client.query("UPDATE fundraising_donations SET status = 'REFUND_PENDING', updated_at = $2 WHERE id = $1", [donation.id, now]);
              createdRefunds.push(refundId);
            }
            await client.query(
              `UPDATE fundraising_donations SET status = 'FAILED', updated_at = $2
               WHERE campaign_id = $1 AND status = 'PENDING'`,
              [campaign.id, now],
            );
            await client.query(
              `UPDATE campaigns SET fundraising_status = 'CANCELLED', status = 'CANCELLED', updated_at = $2 WHERE id = $1`,
              [campaign.id, now],
            );
            await client.query(
              `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, details, created_at)
               VALUES ($1, NULL, 'FUNDRAISING_CANCELLED_UNSIGNED', 'CAMPAIGN', $2, $3, $4)`,
              [randomUUID(), campaign.id, { reason: "ORGANIZER_TERMS_SIGNATURE_MISSING", refundCount: createdRefunds.length }, now],
            );
            return createdRefunds;
          });
          cancelledCampaignIds.push(campaign.id);
          refundIds.push(...result);
        } else if (campaign.fundraising_status === "LOCKED" && closeAt <= now) {
          await inTransaction(pool, async (client) => {
            const locked = await client.query(
              `SELECT id, fundraising_status, terms_locked_at FROM campaigns WHERE id = $1 LIMIT 1 FOR UPDATE`,
              [campaign.id],
            );
            if (!locked.rowCount || locked.rows[0].fundraising_status !== "LOCKED" || locked.rows[0].terms_locked_at == null) return;
            await client.query(
              `UPDATE campaigns SET fundraising_status = 'CLOSED', status = 'ACTIVE', updated_at = $2 WHERE id = $1`,
              [campaign.id, now],
            );
            await client.query(
              `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, details, created_at)
               VALUES ($1, NULL, 'FUNDRAISING_CLOSED', 'CAMPAIGN', $2, $3, $4)`,
              [randomUUID(), campaign.id, { closedAt: now }, now],
            );
          });
          closedCampaignIds.push(campaign.id);
        }
      }
      return { cancelledCampaignIds, closedCampaignIds, refundIds };
    },
  });
}
