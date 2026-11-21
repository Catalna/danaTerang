import { randomUUID } from "node:crypto";

import { decimalAmount, minorUnits } from "./ledger.js";

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function publicDisbursement(row) {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    milestoneId: row.milestone_id,
    amount: decimalAmount(minorUnits(String(row.amount))),
    providerFee: decimalAmount(minorUnits(String(row.provider_fee ?? "0"))),
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

export function createFundraisingService({ repository, paymentProvider = null, now = () => new Date() } = {}) {
  if (!repository) throw new TypeError("A fundraising repository is required");

  return Object.freeze({
    async listOpenCampaigns() {
      const campaigns = await repository.listOpenCampaigns({ now: now() });
      return campaigns.map((campaign) => ({ ...campaign, donationCheckoutAvailable: Boolean(paymentProvider) }));
    },

    async getOpenCampaign(campaignId) {
      const campaign = await repository.getOpenCampaign(campaignId, { now: now() });
      return campaign ? { ...campaign, donationCheckoutAvailable: Boolean(paymentProvider) } : null;
    },

    async createDonationCheckout({ actor, campaignId, amount, reallocationPolicy, idempotencyKey, returnUrl }) {
      if (actor?.role !== "FUNDER") throw failure("FORBIDDEN");
      if (!paymentProvider || typeof paymentProvider.createCheckout !== "function") {
        throw failure("PAYMENT_PROVIDER_UNAVAILABLE");
      }
      const amountUnits = minorUnits(amount);
      if (amountUnits <= 0n) throw failure("INVALID_AMOUNT");
      if (!isHttpUrl(returnUrl)) throw failure("INVALID_RETURN_URL");

      const created = await repository.createDonation({
        actor,
        campaignId,
        amount,
        reallocationPolicy,
        idempotencyKey: idempotencyKey ?? randomUUID(),
        provider: paymentProvider.name,
        now: now(),
      });
      if (created.donation.checkoutUrl) return created.donation;

      let checkout;
      try {
        checkout = await paymentProvider.createCheckout({
          reference: created.donation.id,
          amount: created.donation.amount,
          currency: "IDR",
          description: `Donasi untuk ${created.campaignTitle}`,
          donor: { id: actor.id, email: actor.email },
          returnUrl,
          idempotencyKey: created.donation.id,
        });
      } catch {
        throw failure("PAYMENT_CHECKOUT_UNAVAILABLE");
      }
      if (!checkout || typeof checkout.paymentId !== "string" || typeof checkout.checkoutUrl !== "string" || !isHttpUrl(checkout.checkoutUrl)) {
        throw failure("PAYMENT_CHECKOUT_UNAVAILABLE");
      }
      return repository.attachCheckout({
        donationId: created.donation.id,
        donorId: actor.id,
        providerPaymentId: checkout.paymentId,
        checkoutUrl: checkout.checkoutUrl,
        now: now(),
      });
    },

    async handleProviderWebhook({ providerName, headers, rawBody, body }) {
      if (!paymentProvider || paymentProvider.name !== providerName || typeof paymentProvider.verifyWebhook !== "function") {
        throw failure("PAYMENT_PROVIDER_UNAVAILABLE");
      }
      let event;
      try {
        event = await paymentProvider.verifyWebhook({ headers, rawBody, body });
      } catch {
        throw failure("INVALID_PAYMENT_WEBHOOK");
      }
      if (!event || typeof event.eventId !== "string" || typeof event.type !== "string") throw failure("INVALID_PAYMENT_WEBHOOK");
      if (event.type === "PAYMENT_SETTLED") {
        if (typeof event.paymentId !== "string" || typeof event.amount !== "string" || typeof event.fee !== "string" || event.currency !== "IDR") {
          throw failure("INVALID_PAYMENT_WEBHOOK");
        }
        return repository.settleDonation({
          provider: providerName,
          providerEventId: event.eventId,
          providerEventType: event.type,
          providerPaymentId: event.paymentId,
          amount: event.amount,
          fee: event.fee,
          currency: event.currency,
          now: now(),
        });
      }
      if (event.type === "PAYMENT_FAILED") {
        if (typeof event.paymentId !== "string") throw failure("INVALID_PAYMENT_WEBHOOK");
        return repository.failDonation({
          provider: providerName,
          providerEventId: event.eventId,
          providerEventType: event.type,
          providerPaymentId: event.paymentId,
          now: now(),
        });
      }
      if (event.type === "REFUND_SETTLED") {
        if (typeof event.refundId !== "string" || typeof event.amount !== "string" || event.currency !== "IDR") throw failure("INVALID_PAYMENT_WEBHOOK");
        return repository.settleRefund({
          provider: providerName,
          providerEventId: event.eventId,
          providerEventType: event.type,
          providerRefundId: event.refundId,
          amount: event.amount,
          currency: event.currency,
          now: now(),
        });
      }
      if (event.type === "REFUND_FAILED") {
        if (typeof event.refundId !== "string") throw failure("INVALID_PAYMENT_WEBHOOK");
        return repository.failRefund({
          provider: providerName,
          providerEventId: event.eventId,
          providerEventType: event.type,
          providerRefundId: event.refundId,
          now: now(),
        });
      }
      if (event.type === "PAYOUT_SETTLED") {
        if (typeof event.payoutId !== "string" || typeof event.amount !== "string" || typeof event.fee !== "string" || event.currency !== "IDR") throw failure("INVALID_PAYMENT_WEBHOOK");
        return repository.settleDisbursement({
          provider: providerName,
          providerEventId: event.eventId,
          providerEventType: event.type,
          providerPayoutId: event.payoutId,
          amount: event.amount,
          fee: event.fee,
          currency: event.currency,
          now: now(),
        });
      }
      if (event.type === "PAYOUT_FAILED") {
        if (typeof event.payoutId !== "string") throw failure("INVALID_PAYMENT_WEBHOOK");
        return repository.failDisbursement({
          provider: providerName,
          providerEventId: event.eventId,
          providerEventType: event.type,
          providerPayoutId: event.payoutId,
          now: now(),
        });
      }
      throw failure("UNSUPPORTED_PAYMENT_EVENT");
    },

    async listDonationsForUser(actor) {
      if (actor?.role !== "FUNDER") throw failure("FORBIDDEN");
      return repository.listDonationsForUser(actor.id);
    },

    async getCampaignReconciliation({ actor, campaignId }) {
      if (actor?.role !== "ADMIN" && actor?.role !== "ORGANIZER") throw failure("FORBIDDEN");
      return repository.getCampaignReconciliation({ actor, campaignId });
    },

    async processDeadlines() {
      const result = await repository.processFundraisingDeadlines({ now: now() });
      await processPendingRefunds();
      return result;
    },

    async processPendingRefunds() {
      return processPendingRefunds();
    },

    async simulateDonationSettlement({ actor, donationId }) {
      if (!paymentProvider?.simulated || actor?.role !== "FUNDER") throw failure("SIMULATION_DISABLED");
      const donation = await repository.getDonationForUser({ donorId: actor.id, donationId });
      if (donation.status === "PAID") return donation;
      if (donation.status !== "PENDING" && donation.status !== "FAILED") throw failure("DONATION_NOT_PENDING");
      return repository.settleDonation({
        provider: paymentProvider.name,
        providerEventId: `simulated-payment:${donation.id}`,
        providerEventType: "PAYMENT_SETTLED",
        providerPaymentId: donation.providerPaymentId,
        amount: donation.amount,
        fee: "0.00",
        currency: "IDR",
        now: now(),
      });
    },

    async requestSurplusTransfer({ actor, sourceCampaignId, destinationCampaignId, amount, reason }) {
      return repository.requestSurplusTransfer({ actor, sourceCampaignId, destinationCampaignId, amount, reason, now: now() });
    },

    async requestCampaignSurplusRefunds({ actor, campaignId }) {
      const refunds = await repository.requestCampaignSurplusRefunds({ actor, campaignId, now: now() });
      await processPendingRefunds();
      return refunds;
    },

    async approveSurplusTransfer({ actor, transferId }) {
      return repository.approveSurplusTransfer({ actor, transferId, now: now() });
    },

    async listSurplusTransfers({ actor, status = "REQUESTED" }) {
      return repository.listSurplusTransfers({ actor, status });
    },

    async setOrganizationPayoutRecipient({ actor, organizationId, provider, providerRecipientId }) {
      return repository.setOrganizationPayoutRecipient({ actor, organizationId, provider, providerRecipientId, now: now() });
    },

    async requestMilestoneDisbursement({ actor, milestoneId, amount, idempotencyKey }) {
      if (actor?.role !== "ORGANIZER") throw failure("FORBIDDEN");
      if (!paymentProvider || typeof paymentProvider.quotePayout !== "function" || typeof paymentProvider.createPayout !== "function") {
        throw failure("PAYMENT_PROVIDER_UNAVAILABLE");
      }
      let quote;
      try {
        quote = await paymentProvider.quotePayout({ amount, currency: "IDR", milestoneId });
      } catch {
        throw failure("PAYOUT_QUOTE_UNAVAILABLE");
      }
      if (typeof quote?.fee !== "string") throw failure("PAYOUT_QUOTE_UNAVAILABLE");
      try { minorUnits(quote.fee); } catch { throw failure("PAYOUT_QUOTE_UNAVAILABLE"); }
      const result = await repository.createDisbursementRequest({
        actor,
        milestoneId,
        amount,
        providerFee: quote.fee,
        idempotencyKey,
        provider: paymentProvider.name,
        now: now(),
      });
      const row = result.disbursement;
      if (row.status === "PAID" || row.status === "FAILED") return publicDisbursement(row);
      if (row.provider_payout_id) return publicDisbursement(row);
      let payout;
      try {
        payout = await paymentProvider.createPayout({
          recipientId: row.recipient_reference,
          amount: row.amount,
          providerFee: row.provider_fee,
          currency: row.currency,
          reference: row.id,
          idempotencyKey: row.id,
        });
      } catch {
        throw failure("PAYOUT_SUBMISSION_UNAVAILABLE");
      }
      if (typeof payout?.payoutId !== "string") throw failure("PAYOUT_SUBMISSION_UNAVAILABLE");
      const attached = await repository.attachPayout({ disbursementId: row.id, providerPayoutId: payout.payoutId, now: now() });
      if (paymentProvider.simulated) {
        await repository.settleDisbursement({
          provider: paymentProvider.name,
          providerEventId: `simulated-payout:${row.id}`,
          providerEventType: "PAYOUT_SETTLED",
          providerPayoutId: payout.payoutId,
          amount: publicDisbursement(attached).amount,
          fee: publicDisbursement(attached).providerFee,
          currency: "IDR",
          now: now(),
        });
        return { ...publicDisbursement(attached), status: "PAID" };
      }
      return publicDisbursement(attached);
    },
  });

  async function processPendingRefunds() {
    if (!paymentProvider || typeof paymentProvider.createRefund !== "function") return [];
    const refunds = await repository.listPendingRefunds();
    const submitted = [];
    for (const refund of refunds) {
      if (refund.providerRefundId || refund.provider !== paymentProvider.name) continue;
      try {
        const result = await paymentProvider.createRefund({
          paymentId: refund.providerPaymentId,
          amount: refund.amount,
          currency: refund.currency,
          idempotencyKey: refund.id,
        });
        if (typeof result?.refundId !== "string") continue;
        await repository.attachProviderRefund({ refundId: refund.id, providerRefundId: result.refundId, now: now() });
        submitted.push(refund.id);
        if (paymentProvider.simulated) {
          await repository.settleRefund({
            provider: paymentProvider.name,
            providerEventId: `simulated-refund:${refund.id}`,
            providerEventType: "REFUND_SETTLED",
            providerRefundId: result.refundId,
            amount: refund.amount,
            currency: refund.currency,
            now: now(),
          });
        }
      } catch {
        // A later worker cycle retries with the same provider idempotency key.
      }
    }
    return submitted;
  }
}
