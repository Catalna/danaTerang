# DanaTerang Blockchain Sepolia Go-Live Implementation Plan

> **For agentic workers:** Use `executing-plans` and TDD to implement this approved plan inline on `main`. Do not commit keys; never place Verifier private keys on the server.

**Goal:** Take the already-implemented blockchain layer (PeerReviewQuorum + ProofAnchor, backend relayer, receipt persistence) from locally-tested to live on Sepolia, because this is a competition requirement.

**Why:** The on-chain layer makes decisions and evidence tamper-evident: a locked three-Verifier roster, 2-of-3 signed vote finalization without Admin override, and immutable SHA-256 commitments of canonical proof packages.

**Tech Stack:** Solidity 0.8.37 + OpenZeppelin 5.4, solc-js, ethers.js 6.17 deployer/relayer, Alchemy Sepolia RPC, Etherscan explorer.

---

## Current state (done before this plan)

- Contracts implemented and green in in-process EVM tests (12/12): roster validation, EIP-712 votes, 2-of-3 finality, NO_QUORUM, peer-quorum roster update; ProofAnchor relayer-only anchoring with duplicate rejection.
- Backend: chain adapters with startup validation (chain id, bytecode, relayer identity), quorum service with relayer, proof anchoring service with idempotent retries, `proofs` table receipts.
- Local `.env` holds the user's Alchemy Sepolia RPC URL (verified: responds with chain 11155111).

## Tasks

- [x] Deploy script `packages/review-contract/scripts/deploy.js` + npm script `deploy`: validates arguments, computes organization commitments with the backend formula (`sha256("danaterang:organization:v1:<uuid>")`), connects to Sepolia, checks deployer balance, deploys `PeerReviewQuorum(verifiers, commitments, relayer)` and `ProofAnchor(relayer)`, prints `.env` lines.
- [x] Smoke-tested against the user's RPC up to the funding gate (correct chain, balance check, clear faucet error).
- [x] Relayer wallet funded with faucet Sepolia ETH; key lives in the untracked `backend/.env`.
- [x] Run the deploy with three Verifier wallet addresses and their organization UUIDs; record both contract addresses into `backend/.env`.
- [x] Restart the API and confirm startup logs pass the chain/contract/relayer validation; exercise one full on-chain round in the running app (bind verifier wallet, open round, submit votes, quorum, proof ANCHORED).
- [ ] Minimal proof UI for the demo: Admin proofs list + retry, Organizer/Funder proof status panel (backend endpoints already exist).
- [ ] Blockchain README section + demo script for judges (what to show, Etherscan links).

## Security invariants (non-negotiable)

- The relayer key lives only in the untracked `backend/.env`; it pays gas and relays signatures but can never choose an outcome.
- Verifier keys stay in their owners' wallets (MetaMask or generated for demo); the server only ever receives signatures, never keys.
- Roster and organization commitments are fixed at deployment; changes require 2-of-3 peer signatures on-chain.


## Deployment record (2026-11-21)

- Final deployment (correct roster: wallets per user, organization commitments computed from the live database on port 5432):
  - PeerReviewQuorum `0x085950c4c0308e5da47c9d6437e39a13bdd1f7aa` — deploy tx `0xb186173a0751554b5863b350512a2601f5d49acdd0afe7a6b6768bf0d308bca5`
  - ProofAnchor `0x3366085b849b1151d3f7284d8e138f1419709956` — deploy tx `0xb5fdcc3f0a5f100ae41a71b290a76b0bb4e6342d388ac2943ae4289b5101f781`
- Verified on-chain: roster version 1, all three wallet addresses `isVerifier = true`, `reviewRelayer` equals the service relayer `0xdcf89b628aaee7b4C91Ce3d594049E596Dd9c85C`.
- API restarted with the addresses; health OK, review routes mounted (401 unauthenticated), all three Verifier accounts log in.
- Superseded deployments (do not use): user's earlier Remix deploy `0x0c8379117a013fc72137ccd5564764540eed5f1b` / `0xfbea13427b837ef4bfeafa0297f9a57f52942e88` (roster unknown), and my first deploy `0x16142fc3e9dc0f63a3f70d63f3b8fdc628e370db` / `0x991855a3108cfe090cade85a0f1965f5fd20b253` (organization commitments computed from the stale portable-5433 database UUIDs).
- Lesson recorded: always read organization UUIDs from the database that `backend/.env` `DATABASE_URL` actually points to.
