import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import { createVoteRelay } from "../../src/review/voteRelay.js";
import { VOTE_TYPES } from "../../src/review/eip712.js";

const bytes32 = (byte) => `0x${byte.repeat(64)}`;
const ZERO = bytes32("0");

async function fixture() {
  const wallet = Wallet.createRandom();
  const domain = { name: "DanaTerang Peer Review", version: "1", chainId: 31337, verifyingContract: `0x${"a".repeat(40)}` };
  const source = {
    voteId: "vote-1", submissionId: "submission-1", reviewRoundId: "round-1", attemptCount: 1,
    reviewId: bytes32("1"), evidenceCommitment: bytes32("2"),
    organizerOrganizationCommitment: bytes32("3"), funderOrganizationCommitment: bytes32("4"),
    roundNumber: 1, walletAddress: wallet.address, decision: "VERIFIED", instructionCommitment: null,
    noConflictAttested: true, reviewRoundStatus: "OPEN", verifierActive: true,
  };
  source.signature = await wallet.signTypedData(domain, VOTE_TYPES, {
    reviewId: source.reviewId, evidenceCommitment: source.evidenceCommitment,
    organizerOrganizationCommitment: source.organizerOrganizationCommitment,
    funderOrganizationCommitment: source.funderOrganizationCommitment,
    round: 1, decision: 1, instructionCommitment: ZERO, noConflictAttested: true,
  });
  const calls = { failed: [], sends: 0, confirms: 0 };
  const repository = {
    async claimVoteRelay() { return source; },
    async markVoteSubmissionFailed(input) { calls.failed.push(input); },
    async markVoteSubmitted() {}, async confirmVoteSubmission() { calls.confirms += 1; },
  };
  const contract = {
    async hasVoted() { return false; },
    async submitVote() { calls.sends += 1; return { hash: bytes32("5"), async wait() { return { status: 1, blockNumber: 10, logs: [] }; } }; },
  };
  return { source, calls, repository, contract, domain };
}

test("tampered durable vote payloads cannot be relayed or retried indefinitely", async () => {
  const context = await fixture();
  context.source.decision = "REJECTED";
  const relay = createVoteRelay(context);
  const result = await relay.relayOne({ voteId: "vote-1" });
  assert.equal(result.errorCode, "INVALID_VOTE_SIGNATURE");
  assert.equal(context.calls.sends, 0);
  assert.equal(context.calls.failed[0].exhaustAttempts, 8);
});

test("a different on-chain decision is surfaced as a conflict instead of overwriting the stored vote", async () => {
  const context = await fixture();
  context.contract.hasVoted = async () => true;
  context.contract.filters = { VoteSubmitted: () => "filter" };
  context.contract.queryFilter = async () => [{ args: {
    reviewId: context.source.reviewId, round: 1, verifier: context.source.walletAddress,
    decision: 3, instructionCommitment: ZERO,
  }, transactionHash: bytes32("6") }];
  const result = await createVoteRelay(context).relayOne({ voteId: "vote-1" });
  assert.equal(result.errorCode, "CHAIN_VOTE_EVENT_MISMATCH");
  assert.equal(context.calls.sends, 0);
  assert.equal(context.calls.confirms, 0);
  assert.equal(context.source.decision, "VERIFIED");
});

test("suspended Verifiers' unsent votes are not broadcast", async () => {
  const context = await fixture();
  context.source.verifierActive = false;
  const result = await createVoteRelay(context).relayOne({ voteId: "vote-1" });
  assert.equal(result.errorCode, "FORBIDDEN");
  assert.equal(context.calls.sends, 0);
});

test("a replacement receipt cannot confirm a vote under the original transaction hash", async () => {
  const context = await fixture();
  context.contract.submitVote = async () => ({ hash: bytes32("5"), async wait() {
    throw Object.assign(new Error("replaced"), { code: "TRANSACTION_REPLACED", cancelled: false, receipt: { status: 1, blockNumber: 10, hash: bytes32("6"), logs: [] } });
  } });
  const result = await createVoteRelay(context).relayOne({ voteId: "vote-1" });
  assert.equal(result.errorCode, "CHAIN_RECEIPT_FAILED");
  assert.equal(context.calls.confirms, 0);
  assert.equal(context.calls.failed[0].errorCode, "CHAIN_RECEIPT_FAILED");
});
