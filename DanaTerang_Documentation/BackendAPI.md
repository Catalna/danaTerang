# DanaTerang — Backend API

## 1. Backend Responsibilities

The backend is the orchestration layer.

It coordinates:

- auth,
- RBAC,
- campaign workflow,
- milestone workflow,
- file upload,
- raw SHA-256 before OCR/redaction and canonical-package hashing,
- Indonesian/English OCR with per-field confidence,
- independent screening state,
- permissioned Verifier quorum and version-specific review,
- authenticated public donations, verified payment-provider events, escrow ledger, refunds, milestone payouts, and related-cause transfers,
- blockchain anchoring,
- audit logs.

## 2. Suggested Modules

```text
auth/
users/
organizations/
campaigns/
milestones/
evidence/
redaction/
ocr/
screening/
verification/
disbursement/
blockchain/
audit/
```

## 3. Suggested API Endpoints

### Service readiness

```text
GET /health  # process liveness; 200 even in health-only development mode
GET /ready   # complete demo prerequisites and running workers; 200 or 503
```

The readiness response contains allowlisted component status codes only and uses `Cache-Control: no-store`. Database/RPC URLs, credentials, paths, and document data are excluded. `npm run doctor --workspace @dana-terang/api` checks the same setup prerequisites without starting workers or writing to the database/chain.

### Auth

```text
POST /auth/register
POST /auth/login
GET  /auth/me
```

### Campaigns

```text
POST /campaigns
GET  /campaigns
GET  /campaigns/:id
PATCH /campaigns/:id
GET  /public/fundraising-campaigns
GET  /public/fundraising-campaigns/:id
POST /campaigns/:id/donations
GET  /fundraising/donations
GET  /campaigns/:id/reconciliation
GET  /campaigns/:id/terms/prepare
POST /campaigns/:id/terms/lock
POST /campaigns/:id/surplus-transfers
POST /milestones/:id/disbursements
POST /fundraising/webhooks/:provider
GET  /admin/fundraising/surplus-transfers
PATCH /admin/fundraising/surplus-transfers/:id/approve
PATCH /admin/organizations/:id/payout-recipient
```

Donation and payout endpoints require an authenticated Funder/Organizer as appropriate. Donations are not credited to the raised total until a verified provider webhook settles them. `payment_provider_unavailable` is returned until a real provider adapter is configured. Provider callbacks are idempotent; only allowlisted fields are recorded. Final terms are Organizer-signed at H-48. Transfer surplus only between same-category causes when all source donors consent and Admin approves.

### Admin campaign publication

```text
GET   /admin/campaigns  # Admin-only publication status and campaign metadata
PATCH /admin/campaigns/:id/publication  # { "published": boolean }; exact Origin required
```

Campaigns are private by default. Only an active Admin may publish or unpublish a campaign for public audit. The action is audit-logged.

### Milestones

```text
POST /campaigns/:id/milestones
GET  /campaigns/:id/milestones
PATCH /milestones/:id
```

### Evidence

```text
POST /milestones/:id/evidence
GET  /milestones/:id/evidence
GET  /evidence/:id
POST /evidence/:id/revisions
POST /admin/evidence/:id/ocr-retry  # failed OCR before a review round opens; metadata only
POST /evidence/:id/redacted-derivative  # optional; creates a separate file/hash
```

Only Verifiers assigned to that evidence version may download the original or retrieve full OCR. Organizer APIs return their own safe evidence/screening summary and final revision instructions after a `NEEDS_REVISION` quorum. Funder APIs return status only. Admin receives operational metadata only and may request retry of a failed OCR job before review opens, without seeing original bytes or OCR fields. A revision upload is allowed only after a quorum result of `NEEDS_REVISION` and creates a new immutable version without reopening the Milestone. Original file URLs remain private. A redacted derivative receives its own SHA-256 hash and may be published only after explicit approval; it never replaces the original evidence version.

### Verification

```text
GET  /verifier/wallet
POST /verifier/wallet/challenge
POST /verifier/wallet
GET  /verifier/reviews
GET  /verifier/reviews/:reviewRoundId
POST /verifier/reviews/:reviewRoundId/votes/prepare
POST /verifier/reviews/:reviewRoundId/votes
GET  /evidence/:id/ocr  # assigned Verifier only
GET  /admin/reviews  # operations metadata and vote counts only
```

Full OCR responses include nullable `runs[].ai` provenance: `status` (`APPLIED`, `UNAVAILABLE`, `DISABLED`), `reason`, `model`, `pagesSent`, `attempts`, `durationMs`, and per-field `fields` (`source`, `diverged`, `tesseractValue`, `geminiValue`, `tesseractConfidence`, `aiConfidence`). Vision recovery also records `ocrFailureCode` when the local engine failed. Historical runs may have `ai: null`. Provenance is available only to the assigned Verifier and is excluded from Organizer/Funder/Admin summaries and public responses.

Wallet binding uses a one-time typed-data challenge scoped to the configured chain and review contract. `/votes/prepare` returns the exact typed data to sign; `/votes` accepts the signature and persists it append-only before relay. State-changing routes require the exact configured Origin and return `Cache-Control: private, no-store`.

The durable vote relay uses expiring database leases and bounded exponential retries. It revalidates stored EIP-712 signatures, recovers already-cast votes from matching `VoteSubmitted` events/receipts, and stops unsent votes when the review closes or the account is suspended. The assigned Verifier's review detail includes `ownVote.delivery` with submission status, attempts, next retry time, safe error code, and transaction hash. Review/proof sends share one serialized relayer signer in the API process. Wallets referenced by review history cannot be deleted (`409 verifier_wallet_in_use`).

Each round has three independent Verifiers and finalizes only when two distinct EIP-712 signatures agree on the same decision for that evidence version. A relayer pays gas; the contract verifies peer signatures and records the outcome. Admin has no vote or override. If all three votes differ, verification remains `PENDING` with `reviewRoundStatus=NO_QUORUM`. `NEEDS_REVISION` records a separate Organizer-facing instruction commitment; only the owning Organizer sees the final instructions, and only the author sees their internal note. Contract vote events and pseudonymous reviewer addresses are public; original files, OCR text, and notes remain off-chain.

### Optional External Payment Report

The following disbursement endpoint sketch is conceptual and is not required for the Phase 1 demo. It must not imply that DanaTerang moves funds or verifies settlement. If a manual report is implemented, preserve the reporting party and keep its reference private by default. Payment-status meanings and transitions are defined in `StatusStateMachines.md`.

```text
GET  /milestones/:id/disbursement
POST /milestones/:id/disbursement/approve
POST /milestones/:id/disbursement/mark-paid
POST /milestones/:id/disbursement/confirm
```

`/confirm` may set `disbursementStatus=CONFIRMED` only when a separately authorized independent settlement source supports the transition. It must not confirm a funder's manual report.

If the conceptual `/approve` and `/mark-paid` actions are implemented, `/approve` maps to `READY_FOR_PAYMENT` only after the verifier and funder prerequisites are satisfied, while `/mark-paid` maps only to `PAYMENT_REPORTED`. Neither action initiates a transfer.

### Public Audit

```text
GET /public/campaigns
GET /public/campaigns/:id
```

Public responses include only Admin-published campaigns and use an explicit allowlist: campaign title/status/budget, milestone title/status/budget, aggregate evidence-verification counts, and proof status/transaction reference. They never return Organizer/Funder identities, private `fileUrl` values, filenames, raw hashes, OCR fields/text, payment references, revision instructions, or internal review notes.

Unpublished campaign IDs return `404`, including to anonymous callers. A redacted derivative remains out of scope for the current public projection; it requires a separately approved publication workflow.

## 4. Status Fields in Responses

Use state-machine-specific names rather than one ambiguous status field in aggregated campaign views:

```json
{
  "campaignStatus": "ACTIVE",
  "milestoneStatus": "IN_PROGRESS",
  "evidenceStatus": "READY_FOR_REVIEW",
  "screeningStatus": "FLAGGED",
  "reviewRoundStatus": "OPEN",
  "verificationStatus": "PENDING",
  "disbursementStatus": "NOT_READY",
  "proofStatus": "PENDING"
}
```

Allowed states and transitions are defined in `StatusStateMachines.md`.

## 5. Evidence Upload Sequence

```text
Receive file
→ validate file type / size
→ calculate raw SHA-256 over exact bytes
→ upload to object storage
→ save metadata
→ trigger OCR
→ run rules
→ save flags
→ mark ready for review
```

## 6. Blockchain Anchoring Sequence

```text
Record the version-specific peer quorum on Ethereum Sepolia
→ create the versioned canonical JSON package after the quorum outcome
→ encode deterministic package as UTF-8
→ calculate SHA-256 package hash
→ send transaction to Ethereum Sepolia Testnet using ethers.js/backend service wallet
→ wait confirmation
→ store txHash / blockNumber
→ update proof status
```

For Phase 1, the evidence proof is the SHA-256 hash of the versioned canonical package defined in `BlockchainProof.md`. The backend wallet pays gas in Sepolia ETH. Assigned Verifiers sign review votes with their own wallet. An authorized Organizer binds a wallet to sign final campaign terms at H-48; donors do not need a wallet. Rupiah provider settlement is off-chain and is not part of the evidence proof.

## 7. Queue Recommendation

For production use a queue for:

- OCR processing,
- blockchain transactions,
- retries,
- notification jobs.

MVP can use simple background jobs if needed.

## 8. Implemented external payment reports

`GET /api/payment-reports` returns organization/assigned-Funder-scoped reports and Funder-only eligible milestones. `POST /api/milestones/:milestoneId/payment-reports` accepts `requestId` (UUID idempotency key), `reportedAmount` (positive decimal string), `currency`, `paidAt` (calendar date), `transactionReference`, and optional `notes`. Only the campaign's Funder can report, after current evidence is quorum-verified. Reports are append-only, capped cumulatively by the milestone budget under a row lock, and remain `PAYMENT_REPORTED`. Identical retries return the same record. Admin receives metadata without references/notes; unrelated accounts and the public cannot access payment details. Payment data stays outside the evidence proof.
