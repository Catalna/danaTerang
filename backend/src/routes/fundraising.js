import { Router } from "express";

import { isUserId, parseDonationCheckout, parseMilestoneDisbursement, parsePayoutRecipientUpdate, parseSurplusTransfer } from "../auth/validation.js";
import { createSessionMiddleware } from "../middleware/session.js";
import { requireRole } from "../middleware/requireRole.js";

function sendFundraisingError(error, response, next) {
  const mapped = {
    FORBIDDEN: [403, "forbidden"],
    CAMPAIGN_NOT_FOUND: [404, "not_found"],
    FUNDRAISING_CLOSED: [409, "fundraising_closed"],
    CAMPAIGN_TERMS_REQUIRED: [409, "campaign_terms_required"],
    SURPLUS_REFUND_CAMPAIGN_NOT_CLOSED: [409, "campaign_not_closed"],
    SURPLUS_REFUND_MILESTONES_INCOMPLETE: [409, "milestones_incomplete"],
    SURPLUS_PAYOUTS_PENDING: [409, "payouts_pending"],
    SURPLUS_REFUND_DONATIONS_NOT_FOUND: [409, "surplus_refund_not_available"],
    SURPLUS_REFUND_TRANSFERRED_FUNDS_REQUIRE_REVIEW: [409, "transferred_surplus_requires_review"],
    SURPLUS_REFUND_ALLOCATION_FAILED: [409, "surplus_refund_allocation_failed"],
    CAMPAIGN_TERMS_REQUIRED: [409, "campaign_terms_required"],
    INVALID_AMOUNT: [400, "invalid_request"],
    INVALID_REALLOCATION_POLICY: [400, "invalid_request"],
    INVALID_RETURN_URL: [400, "invalid_request"],
    PAYMENT_PROVIDER_UNAVAILABLE: [503, "payment_provider_unavailable"],
    SIMULATION_DISABLED: [404, "not_found"],
    PAYMENT_CHECKOUT_UNAVAILABLE: [503, "payment_checkout_unavailable"],
    INVALID_PAYMENT_WEBHOOK: [401, "invalid_webhook"],
    UNSUPPORTED_PAYMENT_EVENT: [400, "unsupported_payment_event"],
    INVALID_PROVIDER_SETTLEMENT: [400, "invalid_provider_settlement"],
    DONATION_NOT_FOUND: [404, "donation_not_found"],
    DONATION_NOT_PENDING: [409, "donation_not_pending"],
    DONATION_SETTLEMENT_MISMATCH: [409, "donation_settlement_mismatch"],
    DONATION_IDEMPOTENCY_CONFLICT: [409, "donation_idempotency_conflict"],
    REFUND_NOT_FOUND: [404, "refund_not_found"],
    REFUND_NOT_PENDING: [409, "refund_not_pending"],
    REFUND_AMOUNT_MISMATCH: [409, "refund_amount_mismatch"],
    DISBURSEMENT_AMOUNT_MISMATCH: [409, "disbursement_amount_mismatch"],
    LEDGER_RECONCILIATION_FAILED: [409, "ledger_reconciliation_failed"],
    ESCROW_OVERDRAWN: [409, "escrow_overdrawn"],
    DESTINATION_CAMPAIGN_NOT_FOUND: [404, "destination_campaign_not_found"],
    INVALID_TRANSFER_REASON: [400, "invalid_request"],
    SURPLUS_TRANSFER_SOURCE_NOT_CLOSED: [409, "campaign_not_closed"],
    SURPLUS_TRANSFER_DESTINATION_NOT_OPEN: [409, "destination_campaign_not_open"],
    SURPLUS_CAUSE_MISMATCH: [409, "surplus_cause_mismatch"],
    DONOR_CONSENT_REQUIRED: [409, "donor_consent_required"],
    SURPLUS_REFUNDS_PENDING: [409, "surplus_refunds_pending"],
    ESCROW_INSUFFICIENT: [409, "escrow_insufficient"],
    SURPLUS_TRANSFER_NOT_FOUND: [404, "surplus_transfer_not_found"],
    SURPLUS_TRANSFER_NOT_REQUESTED: [409, "surplus_transfer_not_requested"],
    SURPLUS_TRANSFER_STATUS_CHANGED: [409, "surplus_transfer_status_changed"],
    INVALID_TRANSFER_STATUS: [400, "invalid_request"],
    ORGANIZATION_NOT_FOUND: [404, "organization_not_found"],
    MILESTONE_NOT_FOUND: [404, "milestone_not_found"],
    CAMPAIGN_NOT_CLOSED: [409, "campaign_not_closed"],
    MILESTONE_NOT_COMPLETED: [409, "milestone_not_completed"],
    MILESTONE_NOT_VERIFIED: [409, "milestone_not_verified"],
    PAYOUT_RECIPIENT_NOT_READY: [409, "payout_recipient_not_ready"],
    DISBURSEMENT_IDEMPOTENCY_CONFLICT: [409, "disbursement_idempotency_conflict"],
    DISBURSEMENT_BUDGET_EXCEEDED: [409, "disbursement_budget_exceeded"],
    DISBURSEMENT_NOT_FOUND: [404, "disbursement_not_found"],
    DISBURSEMENT_NOT_PENDING: [409, "disbursement_not_pending"],
    PAYOUT_SUBMISSION_UNAVAILABLE: [503, "payout_submission_unavailable"],
    PAYOUT_QUOTE_UNAVAILABLE: [503, "payout_quote_unavailable"],
    "23505": [409, "conflict"],
  }[error?.code];
  if (mapped) return response.status(mapped[0]).json({ error: mapped[1] });
  return next(error);
}

function requireConfiguredOrigin(webOrigin) {
  return function checkOrigin(request, response, next) {
    if (!webOrigin || request.get("origin") !== webOrigin) return response.status(403).json({ error: "forbidden" });
    return next();
  };
}

export function createFundraisingRouter({ fundraisingService, authService, webOrigin, nodeEnv = process.env.NODE_ENV }) {
  if (!fundraisingService || !authService) throw new TypeError("Fundraising routes require the fundraising and auth services");
  const router = Router();
  const session = createSessionMiddleware(authService);
  const requireFunder = requireRole("FUNDER");
  const requireOrganizer = requireRole("ORGANIZER");
  const requireAdmin = requireRole("ADMIN");
  const origin = requireConfiguredOrigin(webOrigin);

  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    return next();
  });

  router.get("/public/fundraising-campaigns", async (_request, response, next) => {
    try {
      return response.status(200).json({ campaigns: await fundraisingService.listOpenCampaigns() });
    } catch (error) {
      return sendFundraisingError(error, response, next);
    }
  });

  router.get("/public/fundraising-campaigns/:campaignId", async (request, response, next) => {
    if (!isUserId(request.params.campaignId)) return response.status(400).json({ error: "invalid_request" });
    try {
      const campaign = await fundraisingService.getOpenCampaign(request.params.campaignId);
      if (!campaign) return response.status(404).json({ error: "not_found" });
      return response.status(200).json({ campaign });
    } catch (error) {
      return sendFundraisingError(error, response, next);
    }
  });

  router.post("/campaigns/:campaignId/donations", origin, session, requireFunder, async (request, response, next) => {
    if (!isUserId(request.params.campaignId)) return response.status(400).json({ error: "invalid_request" });
    const input = parseDonationCheckout(request.body);
    if (!input) return response.status(400).json({ error: "invalid_request" });
    try {
      const result = await fundraisingService.createDonationCheckout({
        actor: request.currentUser,
        campaignId: request.params.campaignId,
        ...input,
      });
      return response.status(result.status === "PENDING" ? 201 : 200).json({ donation: result });
    } catch (error) {
      return sendFundraisingError(error, response, next);
    }
  });

  if (["development", "test"].includes(nodeEnv)) {
    router.post("/test/fundraising/donations/:donationId/settle", origin, session, requireFunder, async (request, response, next) => {
      if (!isUserId(request.params.donationId)) return response.status(400).json({ error: "invalid_request" });
      try {
        const result = await fundraisingService.simulateDonationSettlement({ actor: request.currentUser, donationId: request.params.donationId });
        return response.status(200).json({ donation: result.donation ?? result });
      } catch (error) {
        return sendFundraisingError(error, response, next);
      }
    });
  }

  router.get("/fundraising/donations", session, requireFunder, async (request, response, next) => {
    try {
      return response.status(200).json({ donations: await fundraisingService.listDonationsForUser(request.currentUser) });
    } catch (error) {
      return sendFundraisingError(error, response, next);
    }
  });

  router.get("/campaigns/:campaignId/reconciliation", session, requireRole("ORGANIZER", "ADMIN"), async (request, response, next) => {
    if (!isUserId(request.params.campaignId)) return response.status(400).json({ error: "invalid_request" });
    try {
      const reconciliation = await fundraisingService.getCampaignReconciliation({ actor: request.currentUser, campaignId: request.params.campaignId });
      return response.status(200).json({ reconciliation });
    } catch (error) {
      return sendFundraisingError(error, response, next);
    }
  });

  router.get("/admin/fundraising/surplus-transfers", session, requireAdmin, async (request, response, next) => {
    const status = typeof request.query.status === "string" ? request.query.status : "REQUESTED";
    try {
      return response.status(200).json({ transfers: await fundraisingService.listSurplusTransfers({ actor: request.currentUser, status }) });
    } catch (error) {
      return sendFundraisingError(error, response, next);
    }
  });

  router.post("/campaigns/:campaignId/surplus-transfers", origin, session, requireOrganizer, async (request, response, next) => {
    if (!isUserId(request.params.campaignId)) return response.status(400).json({ error: "invalid_request" });
    const input = parseSurplusTransfer(request.body);
    if (!input) return response.status(400).json({ error: "invalid_request" });
    try {
      const transfer = await fundraisingService.requestSurplusTransfer({ actor: request.currentUser, sourceCampaignId: request.params.campaignId, ...input });
      return response.status(201).json({ transfer });
    } catch (error) {
      return sendFundraisingError(error, response, next);
    }
  });

  router.post("/campaigns/:campaignId/surplus-refunds", origin, session, requireOrganizer, async (request, response, next) => {
    if (!isUserId(request.params.campaignId)) return response.status(400).json({ error: "invalid_request" });
    if (request.body && Object.keys(request.body).length > 0) return response.status(400).json({ error: "invalid_request" });
    try {
      const refunds = await fundraisingService.requestCampaignSurplusRefunds({ actor: request.currentUser, campaignId: request.params.campaignId });
      return response.status(202).json({ refunds });
    } catch (error) {
      return sendFundraisingError(error, response, next);
    }
  });

  router.patch("/admin/fundraising/surplus-transfers/:transferId/approve", origin, session, requireAdmin, async (request, response, next) => {
    if (!isUserId(request.params.transferId)) return response.status(400).json({ error: "invalid_request" });
    try {
      const transfer = await fundraisingService.approveSurplusTransfer({ actor: request.currentUser, transferId: request.params.transferId });
      return response.status(200).json({ transfer });
    } catch (error) {
      return sendFundraisingError(error, response, next);
    }
  });

  router.patch("/admin/organizations/:organizationId/payout-recipient", origin, session, requireAdmin, async (request, response, next) => {
    if (!isUserId(request.params.organizationId)) return response.status(400).json({ error: "invalid_request" });
    const input = parsePayoutRecipientUpdate(request.body);
    if (!input) return response.status(400).json({ error: "invalid_request" });
    try {
      const recipient = await fundraisingService.setOrganizationPayoutRecipient({
        actor: request.currentUser,
        organizationId: request.params.organizationId,
        ...input,
      });
      return response.status(200).json({ recipient });
    } catch (error) {
      return sendFundraisingError(error, response, next);
    }
  });

  router.post("/milestones/:milestoneId/disbursements", origin, session, requireOrganizer, async (request, response, next) => {
    if (!isUserId(request.params.milestoneId)) return response.status(400).json({ error: "invalid_request" });
    const input = parseMilestoneDisbursement(request.body);
    if (!input) return response.status(400).json({ error: "invalid_request" });
    try {
      const disbursement = await fundraisingService.requestMilestoneDisbursement({
        actor: request.currentUser,
        milestoneId: request.params.milestoneId,
        ...input,
      });
      return response.status(202).json({ disbursement });
    } catch (error) {
      return sendFundraisingError(error, response, next);
    }
  });

  router.post("/fundraising/webhooks/:provider", async (request, response, next) => {
    try {
      const result = await fundraisingService.handleProviderWebhook({
        providerName: request.params.provider,
        headers: request.headers,
        rawBody: request.rawBody,
        body: request.body,
      });
      return response.status(200).json({ received: true, duplicate: Boolean(result?.duplicate) });
    } catch (error) {
      return sendFundraisingError(error, response, next);
    }
  });

  return router;
}
