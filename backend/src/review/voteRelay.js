import { randomUUID } from "node:crypto";
import { getAddress, verifyTypedData } from "ethers";
import { VOTE_TYPES } from "./eip712.js";

const ZERO = `0x${"0".repeat(64)}`;
const DECISIONS = new Map([["VERIFIED", 1], ["NEEDS_REVISION", 2], ["REJECTED", 3]]);
const HASH = /^0x[0-9a-f]{64}$/i;

function relayError(code) { return Object.assign(new Error(code), { code }); }
function safeCode(error) { return /^[A-Z0-9_]{1,64}$/.test(error?.code ?? "") ? error.code : "VOTE_RELAY_FAILED"; }

function parseOutcome(contract, receipt, transactionHash) {
  for (const log of receipt.logs ?? []) {
    if (log.address?.toLowerCase() !== (contract.target ?? contract.address)?.toLowerCase()) continue;
    let event;
    try { event = contract.interface.parseLog(log); } catch { continue; }
    if (!["ReviewFinalized", "ReviewNoQuorum"].includes(event?.name)) continue;
    const args = event.args;
    const finalized = event.name === "ReviewFinalized";
    return {
      kind: finalized ? "QUORUM_REACHED" : "NO_QUORUM",
      reviewId: args.reviewId ?? args[0], evidenceCommitment: args.evidenceCommitment ?? args[1],
      roundNumber: Number(args.round ?? args[2]),
      decision: finalized ? [...DECISIONS].find(([, value]) => value === Number(args.decision ?? args[3]))?.[0] : null,
      instructionCommitment: finalized ? (args.instructionCommitment ?? args[4]) : null,
      transactionHash, blockNumber: Number(receipt.blockNumber),
    };
  }
  return null;
}

/** Relays immutable Verifier signatures; leases coordinate requests and recovery. */
export function createVoteRelay({ repository, contract, domain, onQuorumFinalized, now: clock = () => new Date(), maxAttempts = 8, leaseMs = 120_000, retryBaseMs = 30_000 }) {
  function retryAt(now, attempt = 1) {
    return new Date(now.getTime() + Math.min(900_000, retryBaseMs * 2 ** Math.min(attempt - 1, 10)));
  }

  async function applyReceipt(submission, receipt, now) {
    now = new Date(Math.max(now.getTime(), clock().getTime()));
    const { voteId, submissionId, transactionHash, reviewRoundId } = submission;
    const base = { voteId, submissionId, transactionHash };
    if (!receipt) return { ...base, status: "PENDING" };
    if (Number(receipt.status) !== 1 || !Number.isSafeInteger(Number(receipt.blockNumber)) || Number(receipt.blockNumber) < 0) {
      await repository.markVoteSubmissionFailed({ voteId, errorCode: "CHAIN_RECEIPT_FAILED", nextAttemptAt: retryAt(now), now });
      return { ...base, status: "PENDING", errorCode: "CHAIN_RECEIPT_FAILED" };
    }
    const event = parseOutcome(contract, receipt, transactionHash);
    // Leave the vote SUBMITTED if outcome persistence fails so recovery can retry.
    const outcome = event ? await repository.reconcileConfirmedOutcome({ reviewRoundId, event, now }) : null;
    await repository.confirmVoteSubmission({ voteId, blockNumber: Number(receipt.blockNumber), now });
    if (outcome?.reviewRoundStatus === "QUORUM_REACHED" && typeof onQuorumFinalized === "function") {
      try { await onQuorumFinalized({ reviewRoundId, decision: outcome.decision, now }); }
      catch (error) { console.error(`Proof creation after quorum failed: ${safeCode(error)}`); }
    }
    return outcome ? {
      ...base, status: outcome.reviewRoundStatus, verificationStatus: outcome.verificationStatus, decision: outcome.decision,
    } : { ...base, status: "PENDING" };
  }

  async function findExistingReceipt(source) {
    if (typeof contract.hasVoted !== "function" || !(await contract.hasVoted(source.reviewId, source.roundNumber, source.walletAddress))) return null;
    if (typeof contract.queryFilter !== "function" || !contract.filters?.VoteSubmitted) throw relayError("CHAIN_VOTE_RECEIPT_UNAVAILABLE");
    const events = await contract.queryFilter(contract.filters.VoteSubmitted(source.reviewId, source.roundNumber, source.walletAddress), 0, "latest");
    const event = events.find((entry) => {
      const args = entry.args;
      return String(args.reviewId ?? args[0]).toLowerCase() === source.reviewId.toLowerCase()
        && Number(args.round ?? args[1]) === source.roundNumber
        && String(args.verifier ?? args[2]).toLowerCase() === source.walletAddress.toLowerCase();
    });
    if (!event) throw relayError("CHAIN_VOTE_RECEIPT_UNAVAILABLE");
    if (Number(event.args.decision ?? event.args[3]) !== DECISIONS.get(source.decision)
        || String(event.args.instructionCommitment ?? event.args[4]).toLowerCase() !== (source.instructionCommitment ?? ZERO).toLowerCase()) {
      throw relayError("CHAIN_VOTE_EVENT_MISMATCH");
    }
    const transactionHash = event.transactionHash ?? event.log?.transactionHash;
    if (!HASH.test(transactionHash)) throw relayError("CHAIN_VOTE_RECEIPT_UNAVAILABLE");
    const receipt = await contract.runner?.provider?.getTransactionReceipt(transactionHash);
    if (!receipt || Number(receipt.status) !== 1) throw relayError("CHAIN_VOTE_RECEIPT_UNAVAILABLE");
    return { transactionHash: transactionHash.toLowerCase(), receipt };
  }

  async function relayOne({ voteId, now = clock() }) {
    const leaseOwner = randomUUID();
    const source = await repository.claimVoteRelay({ voteId, leaseOwner, leaseMs, maxAttempts, now });
    if (!source) return { voteId, status: "PENDING", attempted: false };
    const base = { voteId, submissionId: source.submissionId, status: "PENDING", transactionHash: null };
    async function fail(errorCode, permanent = false) {
      const failedAt = new Date(Math.max(now.getTime(), clock().getTime()));
      await repository.markVoteSubmissionFailed({ voteId, leaseOwner, errorCode, nextAttemptAt: retryAt(failedAt, source.attemptCount), exhaustAttempts: permanent ? maxAttempts : 0, now: failedAt });
      return { ...base, errorCode };
    }
    const vote = {
      reviewId: source.reviewId, evidenceCommitment: source.evidenceCommitment,
      organizerOrganizationCommitment: source.organizerOrganizationCommitment,
      funderOrganizationCommitment: source.funderOrganizationCommitment,
      round: source.roundNumber, decision: DECISIONS.get(source.decision),
      instructionCommitment: source.instructionCommitment ?? ZERO, noConflictAttested: source.noConflictAttested,
    };
    try {
      if (source.noConflictAttested !== true || !vote.decision
          || getAddress(verifyTypedData(domain, VOTE_TYPES, vote, source.signature)) !== getAddress(source.walletAddress)) {
        return fail("INVALID_VOTE_SIGNATURE", true);
      }
    } catch { return fail("INVALID_VOTE_SIGNATURE", true); }

    let existing;
    try { existing = await findExistingReceipt(source); }
    catch (error) {
      return fail(["CHAIN_VOTE_EVENT_MISMATCH", "CHAIN_VOTE_RECEIPT_UNAVAILABLE"].includes(error?.code) ? error.code : "CHAIN_SUBMISSION_FAILED", error?.code === "CHAIN_VOTE_EVENT_MISMATCH");
    }
    let transaction;
    let transactionHash = existing?.transactionHash;
    if (!existing) {
      if (source.reviewRoundStatus !== "OPEN") return fail("REVIEW_NOT_OPEN", true);
      if (!source.verifierActive) return fail("FORBIDDEN", true);
      try { transaction = await contract.submitVote(vote, source.signature); }
      catch { return fail("CHAIN_SUBMISSION_FAILED"); }
      transactionHash = transaction?.hash;
      if (!HASH.test(transactionHash)) return fail("CHAIN_SUBMISSION_FAILED");
      transactionHash = transactionHash.toLowerCase();
    }
    // Persist the hash before waiting. An interrupted write retains the lease;
    // after expiry findExistingReceipt recovers the already-cast on-chain vote.
    await repository.markVoteSubmitted({ voteId, leaseOwner, transactionHash, now });
    let receipt = existing?.receipt;
    if (!existing) {
      try { receipt = await transaction.wait(1, 60_000); }
      catch (error) {
        if (error?.code === "TRANSACTION_REPLACED") {
          // A replacement receipt belongs to another hash. Let event recovery
          // locate the matching vote, or retry the signature if it was cancelled.
          const failedAt = new Date(Math.max(now.getTime(), clock().getTime()));
          await repository.markVoteSubmissionFailed({ voteId, errorCode: "CHAIN_RECEIPT_FAILED", nextAttemptAt: retryAt(failedAt, source.attemptCount), now: failedAt });
          return { ...base, transactionHash, errorCode: "CHAIN_RECEIPT_FAILED" };
        }
        if (!error?.receipt) return { ...base, transactionHash };
        receipt = error.receipt;
      }
    }
    return applyReceipt({ ...source, transactionHash }, receipt, now);
  }

  return Object.freeze({
    relayOne,
    async relayQueuedVotes({ limit = 20, now = clock() } = {}) {
      const ids = await repository.listRetryableVoteIds({ limit, maxAttempts, now });
      const results = [];
      for (const voteId of ids) {
        try { results.push(await relayOne({ voteId, now })); }
        catch (error) { results.push({ voteId, status: "PENDING", errorCode: safeCode(error) }); }
      }
      return results;
    },
    async reconcilePendingVoteSubmissions({ limit = 100, now = clock() } = {}) {
      const submissions = await repository.listPendingVoteSubmissions({ limit });
      const results = [];
      for (const submission of submissions) {
        try {
          const receipt = await contract.runner.provider.getTransactionReceipt(submission.transactionHash);
          if (!receipt) results.push({ voteId: submission.voteId, status: "SUBMITTED", transactionHash: submission.transactionHash });
          else {
            const result = await applyReceipt(submission, receipt, now);
            results.push({ ...result, status: result.errorCode ? "FAILED" : result.status === "PENDING" ? "CONFIRMED" : result.status });
          }
        } catch (error) {
          results.push({ voteId: submission.voteId, status: "SUBMITTED", transactionHash: submission.transactionHash, errorCode: safeCode(error) });
        }
      }
      return results;
    },
  });
}
