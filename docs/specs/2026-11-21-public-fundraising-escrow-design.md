# Public Fundraising and Rupiah Escrow — Design

## Status

Product direction agreed; provider-specific payment and a few settlement policies remain open. This document describes the intended crowdfunding model and is not a claim that live Rupiah payments are already available.

## Product decisions

- Campaigns have a fundraising target, not a donation cap. Donations may exceed the target and remain open until the scheduled close time.
- Donors must have an account. Any account with the donor/Funder role may donate to any open campaign.
- Donations are Rupiah payments through a payment provider. Money is held in escrow/a shared pool and is not paid directly to the campaign creator when donated.
- Under-target campaigns may still use the amount collected.
- Campaign terms may be amended at most twice after creation. Amendments are versioned and audited.
- At H-48 before the scheduled close, the campaign's terms are signed by its authorized campaign party and frozen. Fundraising remains open until the scheduled close.
- After closing, funds are disbursed per milestone, gated by the existing evidence and 2-of-3 independent Verifier review flow.
- Remaining funds may be redirected to a related eligible campaign/cause (for example, another disaster-relief campaign) when the donor accepted that fallback policy. Otherwise, the remainder must be refunded.
- Every amount must reconcile. No amount may disappear into an untracked pooled balance.

## Intended flow

1. An Organizer creates a campaign with a fundraising target, closing time, recipient, and budgeted milestones.
2. The campaign is approved/published for fundraising and appears in the public campaign directory.
3. An authenticated donor selects an amount and submits payment through the selected Rupiah payment provider. The provider returns a checkout/payment reference; only a verified provider callback marks the donation paid.
4. Confirmed net funds are recorded in the campaign's escrow ledger. The public page shows the target, amount raised, goal progress (which can exceed 100%), and remaining closing time.
5. An Organizer can submit up to two campaign amendments before H-48. Each amendment is a single saved revision, can include multiple field changes, and preserves the prior snapshot.
6. At H-48, an authorized Organizer signs the final terms snapshot for the campaign. The snapshot includes the campaign version, target, closing time, recipient, milestones, and surplus policy. Terms become immutable; donations continue until close. Admin does not co-sign.
7. At close, donations are finalized/reconciled and no new donations are accepted. The campaign can proceed even when the target was not reached.
8. For each milestone, the Organizer submits evidence. Once the existing verifier quorum approves it, an authorized payout for that milestone is sent from escrow through the payment provider.
9. At final settlement, any remainder is either refunded or transferred to an eligible related cause under the donor-approved policy. The transfer links the source campaign, destination campaign, amount, and reason.

## Financial reconciliation

For a campaign, every confirmed donation must be accounted for by the following categories:

```text
confirmed gross donations
  = provider fees
  + refunds
  + milestone payouts
  + approved transfers to related campaigns
  + current escrow balance
```

During fundraising and milestone execution, escrow balance may be non-zero and must be displayed. A campaign is financially settled only when the closing escrow balance is zero and the ledger balances. Provider fees are recorded separately rather than hidden as a difference between donations and campaign spending.

Ledger records are append-only. Payment provider events must be idempotent. A donation is not counted as raised while its provider status is pending, failed, or reversed.

## Campaign and financial data

Keep the existing `total_budget` field as the fundraising target during a compatibility period; expose it to clients as `fundraisingTarget`. Track actual confirmed donations separately as derived/ledger-backed values, including:

- confirmed gross raised;
- provider fees;
- available escrow balance;
- milestone payouts;
- refunds;
- approved transfers in/out;
- amount remaining to target (floored at zero) and percentage raised (may exceed 100%).

Do not equate the target with donations received, escrow balance, or milestone payout total.

## Required technical boundaries

- A Rupiah payment provider performs the actual checkout, settlement, refund, and payout. The smart contract cannot custody bank Rupiah.
- The provider is not selected yet. The provider interface uses an explicit local simulation in development/test and fails closed in production until a real adapter, verified webhooks, and escrow/marketplace settlement configuration are supplied. Simulation records no real payment and cannot be used in production.
- If either the Organizer or Admin signature is missing at H-48, stop donation intake, cancel the campaign, and begin refunds.
- The smart contract records the signed terms commitment and campaign lifecycle/payout authorizations; it does not claim that an on-chain event itself moved Rupiah.
- Donor identity and payment references remain private unless an explicit public-disclosure policy is later approved.

## Policies requiring a final decision before live launch

- Which provider/escrow partner is selected and who bears provider fees.
- Which Organizer identity/wallet binding proves authority to sign for the owning Organization.
- Who approves a surplus transfer and what qualifies as a related cause.
- Cancellation, chargeback, failed payout, and donor-requested refund rules.
- Whether a donor may opt out of transfers and receive a refund instead.

## Existing model being replaced

The current implementation requires one `funder_id` per campaign and lets that Funder sign a one-time on-chain activation agreement. It also has manual payment reports, which are not escrow or executed payments. The crowdfunding model replaces the one-Funder-per-campaign assumption with many authenticated donations and milestone disbursements. Compatibility changes should preserve existing test fixtures and historical campaign records while new campaigns use the public fundraising flow.
