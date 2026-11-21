# DanaTerang CampaignRegistry (Funder-Signed Activation) Implementation Plan

> **For agentic workers:** Use `executing-plans` and TDD to implement this approved plan inline on `main`. Do not commit keys; the Funder's wallet never touches the server.

**Goal:** Make "Didanai" mean "recorded on Sepolia": the linked Funder signs the campaign-funding agreement with their wallet, the contract verifies the signature on-chain (`ecrecover`), and the record (campaignId → content commitment) becomes immutable and publicly auditable.

**Decision (agreed with the product owner):** dedicated third contract (Option B) instead of reusing the relayer-only ProofAnchor, because the relayer must never be able to fabricate a funding consent; the contract verifies the Funder's EIP-712 signature itself. Milestones are NOT bound individually — the signed commitment covers the campaign outline (identity, total budget ceiling, currency, dates, organizer, funder); milestone discipline is enforced by the existing budget-ceiling checks plus per-evidence 2-of-3 quorum. Corrections go through signed, append-only amendments.

**Tech Stack:** Solidity 0.8.37 + OpenZeppelin 5.4 (EIP712, ECDSA), solc-js, `@ethereumjs/vm` tests, ethers.js 6.17 relayer (shared wallet), PostgreSQL migration 013, Express 5, Next.js 16 + MetaMask (`eth_signTypedData_v4`).

---

## File Map

- Create `packages/review-contract/contracts/CampaignRegistry.sol`; extend `scripts/compile.js` (emits `src/campaign-registry-abi.json`); create `testHelpers/compile-and-deploy-registry.js`, `test/CampaignRegistry.test.js`, `scripts/deploy-registry.js`.
- Create `backend/src/funding/{config.js,registry.js,fundingService.js}`, `backend/src/repositories/fundingRepository.js`, `backend/src/routes/funding.js`; wire `server.js`/`app.js`; `backend/src/auth/validation.js` gains `parseFundingActivation`.
- Create `database/migrations/013_campaign_funding.sql`/`.down.sql`; update `backend/test/db/migrations.test.js`.
- Frontend: `frontend/app/campaigns/[campaignId]/page.tsx` activation flow becomes prepare → MetaMask sign → activate; `frontend/lib/blockchain.ts` unchanged.
- Tests: contract tests (in-process EVM), backend funding service/route tests (fake registry + pg-mem-style fakes), full suite green.

## Contract design (final, agreed)

- Permissionless submission: the signature IS the authorization, so no relayer restriction is needed (a relayer cannot forge consent; it can only relay genuine signatures). Documented rationale in the contract.
- `fundCampaign(bytes32 campaignId, bytes32 contentCommitment, address funder, bytes signature)` — recovers `CampaignFunding(campaignId, contentCommitment, funder, 1)`; one record per campaignId, forever.
- `amendCampaignFunding(bytes32 campaignId, bytes32 newContentCommitment, uint256 expectedVersion, bytes signature)` — recovers `CampaignFundingAmendment(campaignId, newContentCommitment, version+1)`; signer must equal the recorded funder; append-only versioning.
- Views: `getFunding(campaignId)` → `(contentCommitment, funder, version, fundedAt)`; `fundingVersion(campaignId)`.
- Events: `CampaignFunded`, `CampaignFundingAmended`. Errors: zero inputs, duplicate funding, bad signature, funder mismatch, version mismatch.

## Backend flow (agreed sequencing)

1. `GET /api/campaigns/:campaignId/activate/prepare` (FUNDER, origin-checked) → canonical content commitment (JCS SHA-256 over campaign core: title, description, normalized total budget, currency, funding mode, start/end dates, organizer organization id, funder user id) + EIP-712 typed data with domain `{name: "DanaTerang Campaign Funding", version: "1", chainId, verifyingContract}`.
2. `POST /api/campaigns/:campaignId/activate` body `{signature}` (FUNDER) → verify signature recovers to a wallet (no pre-binding needed), submit `fundCampaign` through the shared relayer, wait for receipt, persist `campaign_funding_records`, then set status ACTIVE. On-chain duplicate → treated as already recorded (crash recovery). Chain/config absent → 503 `funding_disabled`; verification failure → 400.
3. Admin no longer activates campaigns — activation is the Funder's signed commitment by design.

## Tasks

- [ ] Contract + compile emission + in-process EVM tests (valid funding, duplicates, forged/outsider signatures, zero inputs, amendments incl. version replay, no-admin surface).
- [ ] Migration 013 + `fundingRepository` (record + read) + migration test update.
- [ ] `funding` config/registry adapter/service/routes + wiring; service tests (stable commitment, happy path, duplicate recovery, disabled config, wrong-signer).
- [ ] Frontend flow: prepare → sign → activate, with clear Indonesian errors (no MetaMask, wrong network, user rejected).
- [ ] Deploy `CampaignRegistry` to Sepolia, wire `CAMPAIGN_REGISTRY_ADDRESS`, restart, verify `/api/ready` + on-chain surface.
- [ ] Full suite green; docs (BlockchainProof.md, README, .env.example) updated.
