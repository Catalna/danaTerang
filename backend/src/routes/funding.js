import { Router } from "express";

import { isUserId, parseFundingActivation } from "../auth/validation.js";
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
    FUNDING_ANCHOR_FAILED: [502, "funding_anchor_failed"],
    FUNDING_ANCHOR_PENDING: [202, "funding_anchor_pending"],
    // Activation-side errors bubble from the campaign repository.
    CAMPAIGN_NOT_FOUND: [404, "not_found"],
    CAMPAIGN_NOT_IN_DRAFT: [409, "campaign_not_draft"],
    MILESTONES_REQUIRED: [409, "milestones_required"],
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

  router.get(
    "/campaigns/:campaignId/activate/prepare",
    createSessionMiddleware(authService),
    requireFunder,
    async (request, response, next) => {
      try {
        if (!isUserId(request.params.campaignId)) return response.status(400).json({ error: "invalid_request" });
        const walletAddress = request.query.wallet;
        const result = await fundingService.prepareFunding({
          actor: request.currentUser,
          campaignId: request.params.campaignId,
          walletAddress: typeof walletAddress === "string" ? walletAddress : "",
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
