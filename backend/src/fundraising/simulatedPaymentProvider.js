/**
 * Non-production payment adapter for local end-to-end testing. It creates no
 * bank transfer, card charge, refund, or actual payout.
 */
export function createSimulatedPaymentProvider({ webOrigin = "http://localhost:3000" } = {}) {
  if (process.env.NODE_ENV === "production") throw new Error("The simulated provider is unavailable in production");
  return Object.freeze({
    name: "simulated",
    simulated: true,
    async createCheckout({ reference }) {
      const checkout = new URL("/fundraising/demo-checkout", webOrigin);
      checkout.searchParams.set("donationId", reference);
      return { paymentId: `sim-payment-${reference}`, checkoutUrl: checkout.toString() };
    },
    async quotePayout() {
      return { fee: "0.00" };
    },
    async createPayout({ reference }) {
      return { payoutId: `sim-payout-${reference}` };
    },
    async createRefund({ idempotencyKey }) {
      return { refundId: `sim-refund-${idempotencyKey}` };
    },
    async verifyWebhook() {
      throw new Error("Simulated provider settlement uses an authenticated local-only endpoint");
    },
  });
}
