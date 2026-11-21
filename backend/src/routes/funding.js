import { Router } from "express";

import { isUserId, parseFundingActivation, parseCampaignTermsSignature } from "../auth/validation.js";
import { createSessionMiddleware } from "../middleware/session.js";
import { requireRole } from "../middleware/requireRole.js";

function sendFundingError(error, response, next) {
  const mapped = {
    FUNDING_SOURCE_NOT_FOUND: [404, "not_found"],
    FORBIDDEN: [403, "forbidden"],
    CAMPAIGN_ALREADY_FUNDED: [409, "campaign_already_funded"],
    INVALID_FUNDING_WALLET: [400, "invalid_request"],
    INVALID_FUNDING_SIGNATURE: [400, "invalid_funding_signature"],
    FUNDING_DISABLED: [503, "funding_disabled"],
    FUNDING_ALREADY_RECORDED: [409, "funding_already_recorded"],
    FUNDING_WALLET_NOT_BOUND: [409, "funding_wallet_not_bound"],
    FUNDING_WALLET_MISMATCH: [409, "funding_wallet_mismatch"],
    FUNDING_ANCHOR_FAILED: [502, "funding_anchor_failed"],
    FUNDING_ANCHOR_PENDING: [202, "funding_anchor_pending"],
    // Activation-side errors bubble from the campaign repository.
    CAMPAIGN_NOT_FOUND: [404, "not_found"],
    CAMPAIGN_NOT_IN_DRAFT: [409, "campaign_not_draft"],
    MILESTONES_REQUIRED: [409, "milestones_required"],
    CAMPAIGN_TERMS_DISABLED: [503, "campaign_terms_disabled"],
    CAMPAIGN_SIGNER_WALLET_NOT_BOUND: [409, "campaign_signer_wallet_not_bound"],
    CAMPAIGN_SIGNER_WALLET_MISMATCH: [409, "campaign_signer_wallet_mismatch"],
    INVALID_CAMPAIGN_TERMS_SIGNATURE: [400, "invalid_campaign_terms_signature"],
    CAMPAIGN_TERMS_NOT_READY: [409, "campaign_terms_not_ready"],
    CAMPAIGN_TERMS_NOT_FOUND: [404, "campaign_terms_not_found"],
    CAMPAIGN_TERMS_WINDOW_NOT_OPEN: [409, "campaign_terms_window_not_open"],
    CAMPAIGN_TERMS_WINDOW_CLOSED: [409, "campaign_terms_window_closed"],
    CAMPAIGN_TERMS_VERSION_MISMATCH: [409, "campaign_terms_version_mismatch"],
    CAMPAIGN_TERMS_CHAIN_CONFLICT: [409, "campaign_terms_chain_conflict"],
    CAMPAIGN_TERMS_RECOVERY_REQUIRED: [503, "campaign_terms_recovery_required"],
    CAMPAIGN_TERMS_ANCHOR_FAILED: [502, "campaign_terms_anchor_failed"],
    CAMPAIGN_TERMS_ANCHOR_PENDING: [202, "campaign_terms_anchor_pending"],
  }[error?.code];
  if (mapped) return response.status(mapped[0]).json({ error: mapped[1] });
  return next(error);
}

/**
 * Funder-signed campaign activation. The signature is the authorization:
 * prepare builds the readable EIP-712 message, activate submits it to the
 * CampaignRegistry through the relayer after verifying the signature.
 */
export function createFundingRouter({ fundingService, authService, webOrigin }) {
  if (!fundingService || !authService) {
    throw new TypeError("Funding routes require a funding service and auth service");
  }
  const router = Router();
  const requireSession = createSessionMiddleware(authService);
  const requireFunder = requireRole("FUNDER");
  const requireOrganizer = requireRole("ORGANIZER");

  router.get(
    "/campaigns/:campaignId/terms/prepare",
    requireSession,
    requireOrganizer,
    async (request, response, next) => {
      if (!isUserId(request.params.campaignId)) return response.status(400).json({ error: "invalid_request" });
      try {
        return response.status(200).json(await fundingService.prepareCampaignTerms({ actor: request.currentUser, campaignId: request.params.campaignId }));
      } catch (error) {
        return sendFundingError(error, response, next);
      }
    },
  );

  router.post(
    "/campaigns/:campaignId/terms/lock",
    (request, response, next) => {
      if (!webOrigin || request.get("origin") !== webOrigin) return response.status(403).json({ error: "forbidden" });
      return next();
    },
    requireSession,
    requireOrganizer,
    async (request, response, next) => {
      if (!isUserId(request.params.campaignId)) return response.status(400).json({ error: "invalid_request" });
      const input = parseCampaignTermsSignature(request.body);
      if (!input) return response.status(400).json({ error: "invalid_request" });
      try {
        return response.status(200).json(await fundingService.lockCampaignTerms({ actor: request.currentUser, campaignId: request.params.campaignId, ...input }));
      } catch (error) {
        return sendFundingError(error, response, next);
      }
    },
  );

  router.get(
    "/campaigns/:campaignId/activate/prepare",
    createSessionMiddleware(authService),
    requireFunder,
    async (request, response, next) => {
      try {
        if (!isUserId(request.params.campaignId)) return response.status(400).json({ error: "invalid_request" });
        const result = await fundingService.prepareFunding({
          actor: request.currentUser,
          campaignId: request.params.campaignId,
        });
        return response.status(200).json(result);
      } catch (error) {
        return sendFundingError(error, response, next);
      }
    },
  );

  router.post(
    "/campaigns/:campaignId/activate",
    (request, response, next) => {
      if (!webOrigin || request.get("origin") !== webOrigin) return response.status(403).json({ error: "forbidden" });
      return next();
    },
    createSessionMiddleware(authService),
    requireFunder,
    async (request, response, next) => {
      try {
        if (!isUserId(request.params.campaignId)) return response.status(400).json({ error: "invalid_request" });
        const input = parseFundingActivation(request.body);
        if (!input) return response.status(400).json({ error: "invalid_request" });
        const result = await fundingService.activateWithSignature({
          actor: request.currentUser,
          campaignId: request.params.campaignId,
          ...input,
        });
        return response.status(200).json(result);
      } catch (error) {
        return sendFundingError(error, response, next);
      }
    },
  );

  return router;
}
