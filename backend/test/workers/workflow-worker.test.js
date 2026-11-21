import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowWorker } from "../../src/workers/workflowWorker.js";

test("workflow recovery continues to proofs when the review RPC is unavailable", async () => {
  const calls = [];
  const errors = [];
  const worker = createWorkflowWorker({
    reviewRepository: { async createWaitingRounds() { calls.push("rounds"); return []; } },
    peerReviewService: {
      async registerWaitingRounds() { throw Object.assign(new Error("private RPC URL"), { code: "RPC_UNAVAILABLE" }); },
      async reconcilePendingVoteSubmissions() { calls.push("votes"); return []; },
      async relayQueuedVotes() { calls.push("relay-votes"); return []; },
    },
    proofService: {
      async createMissingProofs() { calls.push("create-proofs"); return [{ errorCode: "PROOF_SOURCE_NOT_READY" }]; },
      async retryFailedProofs() { calls.push("anchor-proofs"); return []; },
    },
    onError: (error) => errors.push(error),
  });
  const results = await worker.runOnce();
  assert.deepEqual(calls, ["rounds", "votes", "relay-votes", "create-proofs", "anchor-proofs"]);
  assert.deepEqual(errors, [
    { stage: "register_review_rounds", code: "RPC_UNAVAILABLE" },
    { stage: "create_proofs", code: "PROOF_SOURCE_NOT_READY" },
  ]);
  assert.equal(results[1].errorCode, "RPC_UNAVAILABLE");
});

test("overlapping cycles share work and shutdown drains the active cycle", async () => {
  let release;
  let count = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const worker = createWorkflowWorker({
    reviewRepository: { async createWaitingRounds() { count += 1; await gate; return []; } },
  });
  const first = worker.runOnce();
  assert.equal(first, worker.runOnce());
  let stopped = false;
  const shutdown = worker.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await shutdown;
  assert.equal(count, 1);
  assert.deepEqual(await worker.runOnce(), []);
});
