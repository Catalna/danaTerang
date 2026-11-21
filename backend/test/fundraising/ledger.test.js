import assert from "node:assert/strict";
import test from "node:test";

import { assertBalancedTransactions, escrowBalance, minorUnits, reconcileCampaignLedger } from "../../src/fundraising/ledger.js";

test("IDR ledger uses exact minor units and reconciles fees, payouts, and remaining escrow", () => {
  assert.equal(minorUnits("50000000"), 5_000_000_000n);
  const entries = [
    { transactionId: "donation-1", account: "PAYMENT_CLEARING", entrySide: "DEBIT", amount: "60000000.00" },
    { transactionId: "donation-1", account: "DONATIONS", entrySide: "CREDIT", amount: "60000000.00" },
    { transactionId: "settlement-1", account: "PROVIDER_FEES", entrySide: "DEBIT", amount: "300000.00" },
    { transactionId: "settlement-1", account: "PAYMENT_CLEARING", entrySide: "CREDIT", amount: "300000.00" },
    { transactionId: "settlement-1", account: "ESCROW", entrySide: "DEBIT", amount: "59700000.00" },
    { transactionId: "settlement-1", account: "PAYMENT_CLEARING", entrySide: "CREDIT", amount: "59700000.00" },
    { transactionId: "payout-1", account: "MILESTONE_PAYOUTS", entrySide: "DEBIT", amount: "55000000.00" },
    { transactionId: "payout-1", account: "ESCROW", entrySide: "CREDIT", amount: "55000000.00" },
    { transactionId: "transfer-out-1", account: "CAUSE_TRANSFERS", entrySide: "DEBIT", amount: "4700000.00" },
    { transactionId: "transfer-out-1", account: "ESCROW", entrySide: "CREDIT", amount: "4700000.00" },
  ];

  assert.equal(assertBalancedTransactions(entries), true);
  assert.equal(escrowBalance(entries), 0n);
  assert.deepEqual(reconcileCampaignLedger(entries), {
    donations: "60000000.00",
    providerFees: "300000.00",
    milestonePayouts: "55000000.00",
    refunds: "0.00",
    transfersIn: "0.00",
    transfersOut: "4700000.00",
    platformSupport: "0.00",
    escrow: "0.00",
  });
});

test("ledger rejects unbalanced or overdrawn transactions", () => {
  assert.throws(() => assertBalancedTransactions([
    { transactionId: "bad", account: "ESCROW", entrySide: "DEBIT", amount: "10.00" },
    { transactionId: "bad", account: "DONATIONS", entrySide: "CREDIT", amount: "9.00" },
  ]), { code: "LEDGER_UNBALANCED" });
  assert.throws(() => escrowBalance([{ account: "ESCROW", entrySide: "CREDIT", amount: "0.01" }]), { code: "ESCROW_OVERDRAWN" });
});
