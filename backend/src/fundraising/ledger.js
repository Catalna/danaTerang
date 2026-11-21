export function minorUnits(amount) {
  if (typeof amount !== "string" || !/^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/.test(amount)) {
    throw new TypeError("Amount must be a non-negative decimal with at most two fractional digits");
  }
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

export function decimalAmount(amount) {
  if (typeof amount !== "bigint" || amount < 0n) throw new TypeError("Amount must be a non-negative bigint");
  return `${amount / 100n}.${String(amount % 100n).padStart(2, "0")}`;
}

export function assertBalancedTransactions(entries) {
  const totals = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.transactionId !== "string" || !["DEBIT", "CREDIT"].includes(entry.entrySide)) {
      throw new TypeError("Every ledger entry must have a transactionId and a valid entrySide");
    }
    const amount = minorUnits(String(entry.amount));
    if (amount <= 0n) throw new TypeError("Ledger entry amounts must be positive");
    const currency = entry.currency ?? "IDR";
    const key = `${entry.transactionId}:${currency}`;
    const totalsForTransaction = totals.get(key) ?? { debit: 0n, credit: 0n };
    totalsForTransaction[entry.entrySide === "DEBIT" ? "debit" : "credit"] += amount;
    totals.set(key, totalsForTransaction);
  }
  for (const [key, total] of totals) {
    if (total.debit !== total.credit) throw Object.assign(new Error(`Unbalanced ledger transaction: ${key}`), { code: "LEDGER_UNBALANCED" });
  }
  return true;
}

export function escrowBalance(entries) {
  let balance = 0n;
  for (const entry of entries) {
    if (entry.account !== "ESCROW") continue;
    const amount = minorUnits(String(entry.amount));
    balance += entry.entrySide === "DEBIT" ? amount : -amount;
  }
  if (balance < 0n) throw Object.assign(new Error("Escrow ledger is overdrawn"), { code: "ESCROW_OVERDRAWN" });
  return balance;
}

export function reconcileCampaignLedger(entries) {
  assertBalancedTransactions(entries);
  const totals = {
    donations: 0n,
    providerFees: 0n,
    milestonePayouts: 0n,
    refunds: 0n,
    transfersIn: 0n,
    transfersOut: 0n,
    platformSupport: 0n,
    escrow: escrowBalance(entries),
  };
  for (const entry of entries) {
    const amount = minorUnits(String(entry.amount));
    if (entry.account === "DONATIONS" && entry.entrySide === "CREDIT") totals.donations += amount;
    if (entry.account === "PROVIDER_FEES" && entry.entrySide === "DEBIT") totals.providerFees += amount;
    if (entry.account === "MILESTONE_PAYOUTS" && entry.entrySide === "DEBIT") totals.milestonePayouts += amount;
    if (entry.account === "REFUNDS" && entry.entrySide === "DEBIT") totals.refunds += amount;
    if (entry.account === "CAUSE_TRANSFERS" && entry.entrySide === "CREDIT") totals.transfersIn += amount;
    if (entry.account === "CAUSE_TRANSFERS" && entry.entrySide === "DEBIT") totals.transfersOut += amount;
    if (entry.account === "PLATFORM_SUPPORT" && entry.entrySide === "CREDIT") totals.platformSupport += amount;
  }
  const accounted = totals.providerFees + totals.milestonePayouts + totals.refunds + totals.transfersOut + totals.escrow;
  if (totals.donations + totals.transfersIn + totals.platformSupport !== accounted) {
    throw Object.assign(new Error("Campaign funds do not reconcile"), { code: "LEDGER_RECONCILIATION_FAILED" });
  }
  return Object.freeze({
    donations: decimalAmount(totals.donations),
    providerFees: decimalAmount(totals.providerFees),
    milestonePayouts: decimalAmount(totals.milestonePayouts),
    refunds: decimalAmount(totals.refunds),
    transfersIn: decimalAmount(totals.transfersIn),
    transfersOut: decimalAmount(totals.transfersOut),
    platformSupport: decimalAmount(totals.platformSupport),
    escrow: decimalAmount(totals.escrow),
  });
}
