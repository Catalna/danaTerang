/** Recover durable workflow gaps independently of HTTP requests and OCR timing. */
export function createWorkflowWorker({ reviewRepository, peerReviewService, proofService, fundraisingService, intervalMs = 30_000, onError = () => {} } = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100) throw new TypeError("Invalid workflow interval");
  const steps = [
    ["create_review_rounds", reviewRepository && (() => reviewRepository.createWaitingRounds())],
    ["register_review_rounds", peerReviewService && (() => peerReviewService.registerWaitingRounds())],
    ["reconcile_votes", peerReviewService && (() => peerReviewService.reconcilePendingVoteSubmissions())],
    ["relay_queued_votes", peerReviewService && (() => peerReviewService.relayQueuedVotes())],
    ["create_proofs", proofService && (() => proofService.createMissingProofs())],
    ["reconcile_proofs", proofService && (() => proofService.retryFailedProofs())],
    ["fundraising_deadlines", fundraisingService && (() => fundraisingService.processDeadlines())],
  ].filter(([, run]) => run);
  let timer = null;
  let running = null;
  let stopped = false;

  function report(stage, value) {
    const code = /^[A-Z0-9_]{1,64}$/.test(value ?? "") ? value : "WORKFLOW_STEP_FAILED";
    try { onError({ stage, code }); } catch { /* Continue processing if logging fails. */ }
    return code;
  }

  function runOnce() {
    if (stopped) return Promise.resolve([]);
    if (running) return running;
    running = (async () => {
      const results = [];
      for (const [stage, run] of steps) {
        try {
          const items = await run();
          results.push({ stage, results: items });
          for (const item of Array.isArray(items) ? items : []) {
            if (item.errorCode || item.anchorError) report(stage, item.errorCode ?? item.anchorError);
          }
        } catch (error) {
          const code = report(stage, error?.code);
          results.push({ stage, errorCode: code });
        }
      }
      return results;
    })().finally(() => { running = null; });
    return running;
  }

  return Object.freeze({
    getStatus() { return { running: timer !== null && !stopped }; },
    runOnce,
    start() {
      if (timer || stopped) return;
      void runOnce();
      timer = setInterval(() => { void runOnce(); }, intervalMs);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      timer = null;
      await running;
    },
  });
}
