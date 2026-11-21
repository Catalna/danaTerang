import { Router } from "express";
import { isUserId, parsePaymentReport } from "../auth/validation.js";
import { createSessionMiddleware } from "../middleware/session.js";
import { requireRole } from "../middleware/requireRole.js";

export function createPaymentRouter({ paymentRepository, authService, webOrigin }) {
  const router = Router();
  const session = createSessionMiddleware(authService);
  router.use((_request, response, next) => { response.set("Cache-Control", "private, no-store"); next(); });
  router.get("/payment-reports", session, requireRole("ADMIN", "ORGANIZER", "FUNDER"), async (request, response, next) => {
    try {
      const reports = await paymentRepository.listForUser(request.currentUser);
      const eligibleMilestones = await paymentRepository.listEligibleMilestones(request.currentUser);
      return response.json({ reports, eligibleMilestones });
    } catch (error) { return next(error); }
  });
  router.post("/milestones/:milestoneId/payment-reports", (request, response, next) => {
    if (!webOrigin || request.get("origin") !== webOrigin) return response.status(403).json({ error: "forbidden" });
    next();
  }, session, requireRole("FUNDER"), async (request, response, next) => {
    const input = parsePaymentReport(request.body);
    if (!isUserId(request.params.milestoneId) || !input) return response.status(400).json({ error: "invalid_request" });
    try {
      const result = await paymentRepository.createReport({ actor: request.currentUser, milestoneId: request.params.milestoneId, ...input });
      return response.status(result.created ? 201 : 200).json({ report: result.report });
    } catch (error) {
      const mapped = {
        FORBIDDEN: [403, "forbidden"], MILESTONE_NOT_FOUND: [404, "not_found"],
        PAYMENT_NOT_READY: [409, "payment_not_ready"], PAYMENT_BUDGET_EXCEEDED: [409, "payment_budget_exceeded"],
        PAYMENT_REQUEST_CONFLICT: [409, "payment_request_conflict"], CURRENCY_MISMATCH: [400, "invalid_request"],
        "23505": [409, "payment_request_conflict"],
      }[error?.code];
      return mapped ? response.status(mapped[0]).json({ error: mapped[1] }) : next(error);
    }
  });
  return router;
}
