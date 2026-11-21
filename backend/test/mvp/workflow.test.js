import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import request from "supertest";
import { Wallet } from "ethers";
import { hashProofPackage, hashRawEvidence } from "@dana-terang/proof";

import { createApp } from "../../src/app.js";
import { hashPassword } from "../../src/auth/passwords.js";
import { TERMS_VERSION } from "../../src/auth/validation.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createOcrWorker } from "../../src/ocr/ocrWorker.js";
import { createAiEnricher } from "../../src/ocr/aiEnricher.js";
import { readOcrConfig } from "../../src/ocr/config.js";
import { createDocumentRasterizer } from "../../src/ocr/documentRasterizer.js";
import { createTesseractEngine } from "../../src/ocr/tesseractEngine.js";
import { createSyntheticReceiptPng, SYNTHETIC_RECEIPT_FIELDS } from "../../src/ocr/smokeFixture.js";
import { createProofService } from "../../src/proof/proofService.js";
import { createPeerReviewService } from "../../src/review/peerReviewService.js";
import { createAuthRepository } from "../../src/repositories/authRepository.js";
import { createCampaignRepository } from "../../src/repositories/campaignRepository.js";
import { createEvidenceRepository } from "../../src/repositories/evidenceRepository.js";
import { createOcrRepository } from "../../src/repositories/ocrRepository.js";
import { createProofRepository } from "../../src/repositories/proofRepository.js";
import { createReviewRepository } from "../../src/repositories/reviewRepository.js";
import { createLocalFileStorage } from "../../src/storage/localFileStorage.js";
import { createWorkflowWorker } from "../../src/workers/workflowWorker.js";
import { createTestPostgres } from "../../testHelpers/postgres.js";
import { createLocalChain } from "../../testHelpers/localChain.js";

const ORIGIN = "http://localhost:3000";
const PASSWORD = "synthetic-test-password-2026";

test("MVP: upload → OCR → late wallet binding → 2-of-3 EVM quorum → recovered proof → public audit", { timeout: 120_000 }, async (t) => {
  const pool = await createTestPostgres();
  t.after(() => pool.end());
  const applied = await runMigrations(pool);
  assert.ok(applied.includes("011_vote_relay_recovery"));
  assert.deepEqual(await runMigrations(pool), []);
  const root = await mkdtemp(join(tmpdir(), "danaterang-mvp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createLocalFileStorage({ root });
  const auth = createAuthRepository(pool);
  const campaigns = createCampaignRepository(pool);
  const proofs = createProofRepository(pool);
  let app = createApp({ authRepository: auth, campaignRepository: campaigns, webOrigin: ORIGIN, nodeEnv: "test" });

  function api(method, path, cookie) {
    const operation = request(app)[method](`/api${path}`).set("Origin", ORIGIN);
    operation.on("response", (res) => { if (res.status >= 400) console.error("HTTP", res.status, method, path); });
    return cookie ? operation.set("Cookie", cookie) : operation;
  }
  async function login(email) {
    const response = await api("post", "/auth/login").send({ email, password: PASSWORD }).expect(200);
    return response.headers["set-cookie"][0].split(";")[0];
  }
  const admin = await auth.createFirstAdmin({ name: "MVP Admin", email: "admin@example.test", passwordHash: await hashPassword(PASSWORD) });
  const adminCookie = await login(admin.user.email);
  const users = [];
  for (const [index, role] of ["ORGANIZER", "FUNDER", "VERIFIER", "VERIFIER", "VERIFIER"].entries()) {
    const email = `mvp-${index}@example.test`;
    const response = await api("post", "/auth/register").send({
      name: `MVP User ${index}`, email, password: PASSWORD,
      organizationName: `Independent Organization ${index}`, organizationType: "NGO", acceptedTermsVersion: TERMS_VERSION,
    }).expect(201);
    if (role !== "ORGANIZER") await api("patch", `/admin/users/${response.body.user.id}/role`, adminCookie).send({ role }).expect(200);
    users.push({ ...(await auth.findUserByEmail(email)), cookie: await login(email) });
  }
  const [organizer, funder, ...verifiers] = users;
  const wallets = verifiers.map(() => Wallet.createRandom());
  const chain = await createLocalChain();
  const organizationCommitments = verifiers.map((verifier) => `0x${createHash("sha256").update(`danaterang:organization:v1:${verifier.organizationId}`).digest("hex")}`);
  const reviewContract = await chain.deploy("abi.json", [wallets.map((wallet) => wallet.address), organizationCommitments, chain.relayer.address]);
  const anchorContract = await chain.deploy("proof-anchor-abi.json", [chain.relayer.address]);
  const reviews = createReviewRepository(pool, { contractAddress: reviewContract.target });
  const evidence = createEvidenceRepository(pool, { reviewRepository: reviews });
  let failReviewHandoff = true;
  const handoffErrors = [];
  const ocr = createOcrRepository(pool, {
    reviewRepository: {
      ...reviews,
      async createRound(client, input) {
        if (failReviewHandoff) {
          failReviewHandoff = false;
          // A changing review adapter may fail after a SQL write. Its transaction
          // must roll back independently from the already-completed OCR run.
          await client.query("UPDATE ocr_runs SET vendor = 'UNCOMMITTED_REVIEW_WRITE' WHERE evidence_id = $1", [input.evidenceId]);
          await client.query("SELECT * FROM unavailable_review_adapter_table");
        }
        return reviews.createRound(client, input);
      },
    },
    onReviewError(event) { handoffErrors.push(event); throw new Error("logger unavailable"); },
  });
  const proofService = createProofService({ repository: proofs, anchorContract, contractAddress: anchorContract.target });
  let failVoteHashWrite = false;
  const relayRepository = {
    ...reviews,
    async markVoteSubmitted(input) {
      if (failVoteHashWrite) { failVoteHashWrite = false; throw new Error("Simulated interrupted hash persistence"); }
      return reviews.markVoteSubmitted(input);
    },
  };
  // Deliberately miss the immediate callback: durable recovery must still build the proof.
  const reviewService = createPeerReviewService({ repository: relayRepository, contract: reviewContract, chainId: chain.chainId, contractAddress: reviewContract.target });
  app = createApp({
    authRepository: auth, campaignRepository: campaigns, evidenceRepository: evidence,
    reviewRepository: reviews, peerReviewService: reviewService, proofRepository: proofs, proofService,
    fundingService: { async activateWithSignature({ actor, campaignId }) { return { campaign: await campaigns.activateCampaign({ actor, campaignId }), funding: null }; } },
    objectStorage: storage, webOrigin: ORIGIN, nodeEnv: "test",
  });
  const worker = createWorkflowWorker({ reviewRepository: reviews, peerReviewService: reviewService, proofService });
  t.after(() => worker.stop());

  const campaign = (await api("post", "/campaigns", organizer.cookie).send({
    funderId: funder.id, title: "MVP Evidence Campaign", totalBudget: "100000", currency: "IDR",
  }).expect(201)).body.campaign;
  const milestone = (await api("post", `/campaigns/${campaign.id}/milestones`, organizer.cookie).send({
    title: "Purchase supplies", budgetAmount: "100000", currency: "IDR", orderIndex: 0,
  }).expect(201)).body.milestone;
  await api("post", `/campaigns/${campaign.id}/activate`, funder.cookie)
    .send({ signature: `0x${"9a".repeat(65)}`, walletAddress: `0x${"5".repeat(40)}` }).expect(200);
  await api("patch", `/milestones/${milestone.id}`, organizer.cookie).send({ status: "IN_PROGRESS" }).expect(200);
  const bytes = createSyntheticReceiptPng();
  const uploaded = (await api("post", `/milestones/${milestone.id}/evidence`, organizer.cookie)
    .field("evidenceType", "RECEIPT").attach("file", bytes, { filename: "private-receipt.png", contentType: "image/png" }).expect(201)).body.evidence;
  assert.equal((await pool.query("SELECT raw_hash FROM evidence WHERE id = $1", [uploaded.id])).rows[0].raw_hash, hashRawEvidence(bytes));
  // Recognition is deterministic here; rasterization, parsing, screening, storage and SQL are real.
  const text = "TOKO CONTOH\nTANGGAL: 31 OKTOBER 2026\nInvoice No: DEMO-2026-01\nTOTAL PEMBAYARAN: IDR 50000";
  const ocrConfig = readOcrConfig();
  const engine = process.env.MVP_REAL_OCR === "true"
    ? createTesseractEngine({ languageDataPath: ocrConfig.languageDataPath })
    : { async initialize() {}, async recognize() { return { text, words: text.split(/\s+/).map((word) => ({ text: word, confidence: 99 })) }; }, async close() {} };
  const ocrWorker = createOcrWorker({
    repository: ocr, storage, renderer: createDocumentRasterizer(),
    engine,
    enricher: createAiEnricher({
      config: { ...ocrConfig.gemini, enabled: true, apiKey: "synthetic-mvp-key", retries: 0 },
      async fetchImpl(_url, init) {
        const body = JSON.parse(init.body);
        assert.equal(body.contents[0].parts[0].inline_data.mime_type, "image/png");
        return { status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
          ...SYNTHETIC_RECEIPT_FIELDS,
          fieldConfidence: { vendor: 99, documentDate: 99, amount: 99, currency: 99, invoiceNumber: 99 }, notes: [],
        }) }] } }] }) };
      },
    }),
    thresholds: { vendor: 70, documentDate: 80, amount: 90, invoiceNumber: 70 },
  });
  t.after(() => ocrWorker.stop());
  await t.test("a failing review adapter and logger cannot roll back completed AI OCR", async () => {
    assert.equal(await ocrWorker.runOnce(), true);
    assert.equal((await pool.query("SELECT status FROM evidence WHERE id = $1", [uploaded.id])).rows[0].status, "READY_FOR_REVIEW");
    const run = (await pool.query("SELECT vendor, ai_enrichment_status FROM ocr_runs WHERE evidence_id = $1", [uploaded.id])).rows[0];
    assert.equal(run.vendor, "TOKO CONTOH");
    assert.equal(run.ai_enrichment_status, "APPLIED");
    assert.equal((await pool.query("SELECT * FROM review_rounds")).rowCount, 0);
    assert.equal((await pool.query("SELECT state FROM ocr_jobs")).rows[0].state, "COMPLETED");
    assert.equal(handoffErrors.length, 1);
    assert.equal(handoffErrors[0].code, "OCR_REVIEW_HANDOFF_FAILED");
    assert.equal((await pool.query("SELECT action FROM audit_logs WHERE action = 'OCR_COMPLETED'")).rowCount, 1);
  });

  for (const [index, verifier] of verifiers.entries()) {
    const wallet = wallets[index];
    const challenge = (await api("post", "/verifier/wallet/challenge", verifier.cookie).send({ walletAddress: wallet.address }).expect(201)).body;
    const { domain, types, message } = challenge.typedData;
    await api("post", "/verifier/wallet", verifier.cookie).send({
      challengeId: challenge.challengeId, walletAddress: wallet.address, signature: await wallet.signTypedData(domain, types, message),
    }).expect(200);
  }
  const recovery = await worker.runOnce();
  assert.equal(recovery.some((stage) => stage.errorCode), false, JSON.stringify(recovery));
  const queue = (await api("get", "/verifier/reviews", verifiers[0].cookie).expect(200)).body.reviews;
  assert.equal(queue.length, 1);
  const roundId = queue[0].reviewRoundId;
  await api("get", `/evidence/${uploaded.id}/file`, adminCookie).expect(403);
  const reviewDetail = (await api("get", `/verifier/reviews/${roundId}`, verifiers[0].cookie).expect(200)).body;
  assert.equal(reviewDetail.ocr.runs[0].ai.status, "APPLIED");
  assert.equal(reviewDetail.ocr.runs[0].ai.fields.amount.source, "tesseract");
  for (const index of [0, 1]) {
    const input = { decision: "VERIFIED", noConflictAttested: true };
    const prepared = (await api("post", `/verifier/reviews/${roundId}/votes/prepare`, verifiers[index].cookie).send(input).expect(200)).body;
    const { domain, types, message } = prepared.typedData;
    const response = await api("post", `/verifier/reviews/${roundId}/votes`, verifiers[index].cookie).send({
      ...input, signature: await wallets[index].signTypedData(domain, types, message),
    }).expect(index === 0 ? 202 : 200);
    assert.equal(response.body.status, index === 0 ? "PENDING" : "QUORUM_REACHED");
  }
  assert.equal(await proofs.findProofByEvidenceId(uploaded.id), null);
  const recovered = await worker.runOnce();
  assert.equal(recovered.some((stage) => stage.errorCode), false, JSON.stringify(recovered));
  const proof = await proofs.findProofByEvidenceId(uploaded.id);
  assert.equal(proof.status, "ANCHORED", JSON.stringify(recovered));
  assert.equal(proof.packageSchemaVersion, 2);
  assert.equal(hashProofPackage(proof.package), proof.packageHash);
  assert.equal(await anchorContract.proofCommitments(proof.proofId), `0x${proof.packageHash}`);
  await worker.runOnce();
  assert.equal((await pool.query("SELECT * FROM proofs")).rowCount, 1);
  assert.equal((await pool.query("SELECT * FROM review_rounds")).rowCount, 1);

  // Crash after broadcast: receipt recovery must include ANCHORING rows.
  await pool.query("UPDATE proofs SET status = 'ANCHORING', block_number = NULL, anchored_at = NULL WHERE proof_id = $1", [proof.proofId]);
  await worker.runOnce();
  assert.equal((await proofs.findProofByProofId(proof.proofId)).status, "ANCHORED");
  // Crash before recording the transaction hash: recover it from ProofAnchored.
  await pool.query(
    `UPDATE proofs SET status = 'ANCHORING', transaction_hash = NULL, block_number = NULL,
       anchored_at = NULL, updated_at = $2 WHERE proof_id = $1`,
    [proof.proofId, new Date(Date.now() - 600_000)],
  );
  await worker.runOnce();
  assert.equal((await proofs.findProofByProofId(proof.proofId)).status, "ANCHORED");
  assert.equal((await proofs.findProofByProofId(proof.proofId)).transactionHash, proof.transactionHash);

  await api("get", `/public/campaigns/${campaign.id}`).expect(404);
  await api("patch", `/admin/campaigns/${campaign.id}/publication`, adminCookie).send({ published: true }).expect(200);
  const publicResult = (await api("get", `/public/campaigns/${campaign.id}`).expect(200)).body.campaign;
  assert.equal(publicResult.verifiedEvidenceCount, 1);
  assert.equal(publicResult.proofs[0].status, "ANCHORED");
  for (const privateValue of ["private-receipt.png", "TOKO CONTOH", organizer.email, funder.email, hashRawEvidence(bytes)]) {
    assert.equal(JSON.stringify(publicResult).includes(privateValue), false);
  }

  async function uploadAndOpen() {
    const item = (await api("post", `/milestones/${milestone.id}/evidence`, organizer.cookie)
      .field("evidenceType", "RECEIPT").attach("file", bytes, { filename: "private-extra.png", contentType: "image/png" }).expect(201)).body.evidence;
    assert.equal(await ocrWorker.runOnce(), true);
    await worker.runOnce();
    const round = (await pool.query("SELECT id FROM review_rounds WHERE evidence_id = $1", [item.id])).rows[0];
    return { item, roundId: round.id };
  }
  async function cast(roundId, index, decision = "VERIFIED", expectedStatus = 200) {
    const input = { decision, noConflictAttested: true, ...(decision === "NEEDS_REVISION" ? { organizerInstructions: "Please attach the full dated receipt." } : {}) };
    const prepared = (await api("post", `/verifier/reviews/${roundId}/votes/prepare`, verifiers[index].cookie).send(input).expect(200)).body;
    const { domain, types, message } = prepared.typedData;
    return api("post", `/verifier/reviews/${roundId}/votes`, verifiers[index].cookie).send({
      ...input, ...(prepared.instructionSalt ? { instructionSalt: prepared.instructionSalt } : {}),
      signature: await wallets[index].signTypedData(domain, types, message),
    }).expect(expectedStatus);
  }

  await t.test("an RPC outage retries stored signatures and stops unsent votes after quorum", async () => {
    const { item, roundId } = await uploadAndOpen();
    const send = reviewContract.submitVote;
    reviewContract.submitVote = async () => { throw new Error("RPC offline"); };
    try {
      for (const index of [0, 1, 2]) await cast(roundId, index, "VERIFIED", 202);
      assert.deepEqual(await reviewService.relayQueuedVotes(), []);
    } finally { reviewContract.submitVote = send; }
    await pool.query("UPDATE review_vote_submissions SET next_attempt_at = $1 WHERE status = 'FAILED'", [new Date(Date.now() - 1)]);
    await worker.runOnce();
    assert.equal((await proofs.findProofByEvidenceId(item.id)).status, "ANCHORED");
    const delivery = await pool.query(
      `SELECT s.status, s.attempt_count, s.last_error_code FROM review_vote_submissions s
       JOIN review_votes v ON v.id = s.vote_id WHERE v.review_round_id = $1 ORDER BY s.status`, [roundId],
    );
    assert.deepEqual(delivery.rows.map((row) => row.status), ["CONFIRMED", "CONFIRMED", "FAILED"]);
    assert.equal(delivery.rows[2].last_error_code, "REVIEW_NOT_OPEN");
    assert.equal(delivery.rows[2].attempt_count, 8);
    assert.equal(Number((await reviewContract.getReview((await pool.query("SELECT review_id FROM review_rounds WHERE id = $1", [roundId])).rows[0].review_id, 1)).voteCount), 2);
    assert.deepEqual(await reviewService.relayQueuedVotes(), []);
  });

  await t.test("a broadcast vote with a lost database hash is recovered even after quorum closes", async () => {
    const { item, roundId } = await uploadAndOpen();
    failVoteHashWrite = true;
    await cast(roundId, 0, "VERIFIED", 500);
    await cast(roundId, 1, "VERIFIED", 200);
    await pool.query("UPDATE review_vote_submissions SET relay_lease_expires_at = $1 WHERE relay_lease_owner IS NOT NULL", [new Date(Date.now() - 1)]);
    const send = reviewContract.submitVote;
    let submissions = 0;
    reviewContract.submitVote = async (...args) => { submissions += 1; return send(...args); };
    try { await worker.runOnce(); } finally { reviewContract.submitVote = send; }
    assert.equal(submissions, 0);
    const delivery = await pool.query(
      `SELECT s.status, s.transaction_hash FROM review_vote_submissions s
       JOIN review_votes v ON v.id = s.vote_id WHERE v.review_round_id = $1`, [roundId],
    );
    assert.ok(delivery.rows.every((row) => row.status === "CONFIRMED" && row.transaction_hash));
    assert.equal((await proofs.findProofByEvidenceId(item.id)).status, "ANCHORED");
  });

  await t.test("three different decisions remain pending without a proof or automatic reopen", async () => {
    const { item, roundId } = await uploadAndOpen();
    await cast(roundId, 0, "VERIFIED", 202);
    await cast(roundId, 1, "NEEDS_REVISION", 202);
    await cast(roundId, 2, "REJECTED", 202);
    await worker.runOnce();
    const round = (await pool.query("SELECT status, decision FROM review_rounds WHERE id = $1", [roundId])).rows[0];
    assert.equal(round.status, "NO_QUORUM");
    assert.equal(round.decision, null);
    assert.equal((await pool.query("SELECT status FROM verifications WHERE evidence_id = $1", [item.id])).rows[0].status, "PENDING");
    assert.equal(await proofs.findProofByEvidenceId(item.id), null);
    await worker.runOnce();
    assert.equal((await pool.query("SELECT id FROM review_rounds WHERE evidence_id = $1", [item.id])).rowCount, 1);
  });

  await t.test("a revision preserves the old proof and creates a new independently verified version", async () => {
    const { item, roundId } = await uploadAndOpen();
    await cast(roundId, 0, "NEEDS_REVISION", 202);
    await cast(roundId, 1, "NEEDS_REVISION", 200);
    await worker.runOnce();
    const previousProof = await proofs.findProofByEvidenceId(item.id);
    assert.equal(previousProof.package.verification.verificationStatus, "NEEDS_REVISION");
    await api("patch", `/milestones/${milestone.id}`, organizer.cookie).send({ status: "COMPLETED" }).expect(200);
    const revision = (await api("post", `/evidence/${item.id}/revisions`, organizer.cookie)
      .attach("file", bytes, { filename: "private-revision.png", contentType: "image/png" }).expect(201)).body.evidence;
    assert.equal(revision.version, 2);
    await ocrWorker.runOnce();
    await worker.runOnce();
    const nextRound = (await pool.query("SELECT id FROM review_rounds WHERE evidence_id = $1", [revision.id])).rows[0];
    await cast(nextRound.id, 0, "VERIFIED", 202);
    await cast(nextRound.id, 1, "VERIFIED", 200);
    await worker.runOnce();
    const nextProof = await proofs.findProofByEvidenceId(revision.id);
    assert.equal(nextProof.status, "ANCHORED");
    assert.equal(nextProof.package.evidenceVersion, 2);
    assert.notEqual(nextProof.proofId, previousProof.proofId);
    assert.equal((await proofs.findProofByEvidenceId(item.id)).packageHash, previousProof.packageHash);
    assert.equal((await pool.query("SELECT status FROM evidence WHERE id = $1", [item.id])).rows[0].status, "SUPERSEDED");
    assert.equal((await pool.query("SELECT status FROM milestones WHERE id = $1", [milestone.id])).rows[0].status, "COMPLETED");
  });
});
