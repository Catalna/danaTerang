import assert from "node:assert/strict";
import test from "node:test";
import { hashProofPackage } from "@dana-terang/proof";

import { buildCanonicalPackage, createProofService } from "../../src/proof/proofService.js";

const ZERO = `0x${"00".repeat(32)}`;
const REVIEW_ROUND_ID = "fca2aa20-71bb-48cb-b6dd-258f36a9b94a";
const EVIDENCE_ID = "1b6f8e20-9c1a-4c1e-8e2b-3f5a6b7c8d90";
const MILESTONE_ID = "2b6f8e20-9c1a-4c1e-8e2b-3f5a6b7c8d90";
const CAMPAIGN_ID = "3b6f8e20-9c1a-4c1e-8e2b-3f5a6b7c8d90";
const REVIEW_ID = `0x${"11".repeat(32)}`;
const CONTRACT_ADDRESS = `0x${"c".repeat(40)}`;
const QUORUM_TRANSACTION_HASH = `0x${"ab".repeat(32)}`;
const FIXED_NOW = new Date("2026-10-06T12:00:00.000Z");

function sourceFixture(overrides = {}) {
  return {
    reviewRoundId: REVIEW_ROUND_ID,
    reviewId: REVIEW_ID,
    roundNumber: 1,
    decision: "VERIFIED",
    contractAddress: CONTRACT_ADDRESS,
    quorumTransactionHash: QUORUM_TRANSACTION_HASH,
    blockNumber: 4321,
    completedAt: new Date("2026-10-06T09:00:00.000Z"),
    evidenceId: EVIDENCE_ID,
    milestoneId: MILESTONE_ID,
    campaignId: CAMPAIGN_ID,
    evidenceType: "RECEIPT",
    rawHash: `0${"a".repeat(63)}`,
    evidenceVersion: 1,
    ocr: {
      detectedLanguage: "id",
      vendor: "PT Maju Jaya",
      documentDate: new Date("2026-09-30T00:00:00.000Z"),
      amount: "1250000",
      currency: "IDR",
      invoiceNumber: "INV-88",
      screeningStatus: "CLEAR",
      fieldConfidence: { vendor: 92, documentDate: 84, amount: 95, invoiceNumber: 88 },
      flagCodes: [],
    },
    now: FIXED_NOW,
    ...overrides,
  };
}

function createFakeProofRepository() {
  const proofs = new Map();
  return {
    proofs,
    async getProofSourceData(reviewRoundId) {
      if (reviewRoundId !== REVIEW_ROUND_ID) throw Object.assign(new Error("PROOF_SOURCE_NOT_FOUND"), { code: "PROOF_SOURCE_NOT_FOUND" });
      return sourceFixture();
    },
    async createProofForRound(input) {
      if (proofs.has(`evidence:${input.evidenceId}`)) {
        return { created: false, proof: proofs.get(`evidence:${input.evidenceId}`) };
      }
      const proof = {
        id: "proof-row-1",
        evidenceId: input.evidenceId,
        reviewRoundId: input.reviewRoundId,
        proofVersion: input.proofVersion,
        packageSchemaVersion: input.packageSchemaVersion ?? 1,
        campaignId: input.campaignId,
        milestoneId: input.milestoneId,
        package: input.canonicalPackage,
        packageHash: input.packageHash,
        proofId: `0x${input.packageHash}`,
        status: "PENDING",
        contractAddress: null,
        transactionHash: null,
        blockNumber: null,
        attempts: 0,
        lastErrorCode: null,
      };
      proofs.set(`evidence:${input.evidenceId}`, proof);
      return { created: true, proof };
    },
    async findProofByProofId(proofId) {
      return [...proofs.values()].find((proof) => proof.proofId === proofId) ?? null;
    },
    async findProofByEvidenceId(evidenceId) {
      return proofs.get(`evidence:${evidenceId}`) ?? null;
    },
    async listAnchorableProofs() {
      return [...proofs.values()].filter((proof) => ["PENDING", "FAILED", "ANCHORING"].includes(proof.status));
    },
    async markAnchoring({ proofId }) {
      const proof = [...proofs.values()].find((entry) => entry.proofId === proofId);
      proof.status = "ANCHORING";
      proof.attempts += 1;
      return proof;
    },
    async markAnchorSubmitted({ proofId, contractAddress, transactionHash }) {
      const proof = [...proofs.values()].find((entry) => entry.proofId === proofId);
      proof.contractAddress = contractAddress;
      proof.transactionHash = transactionHash;
      return proof;
    },
    async markAnchored({ proofId, blockNumber }) {
      const proof = [...proofs.values()].find((entry) => entry.proofId === proofId);
      proof.status = "ANCHORED";
      proof.blockNumber = blockNumber;
      return proof;
    },
    async markFailed({ proofId, errorCode }) {
      const proof = [...proofs.values()].find((entry) => entry.proofId === proofId);
      proof.status = "FAILED";
      proof.lastErrorCode = errorCode;
      return proof;
    },
  };
}

function createFakeAnchorContract({ commitments = new Map(), failSubmit = false, receipt = { status: 1, blockNumber: 42 } } = {}) {
  const submitted = [];
  return {
    submitted,
    commitments,
    runner: { provider: { async getTransactionReceipt(hash) { return { status: 1, blockNumber: 42, hash }; } } },
    async proofCommitments(proofId) {
      return commitments.get(proofId) ?? ZERO;
    },
    async anchorProof(proofId, commitment) {
      submitted.push({ proofId, commitment });
      if (failSubmit) throw new Error("EVM_TRANSACTION_REVERTED");
      if ((commitments.get(proofId) ?? ZERO) !== ZERO) throw new Error("EXPECT_ALREADY_ANCHORED");
      commitments.set(proofId, commitment);
      return { hash: `0x${"ab".repeat(32)}`, async wait() { return receipt; } };
    },
  };
}

test("buildCanonicalPackage produces a stable, text-free schema-2 package", () => {
  const first = buildCanonicalPackage(sourceFixture());
  const second = buildCanonicalPackage(sourceFixture());
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.schemaVersion, 2);
  assert.equal(first.verification.verificationStatus, "VERIFIED");
  assert.equal(first.verification.verifierRef, REVIEW_ID);
  assert.equal(first.quorum.roundNumber, 1);
  assert.equal(first.quorum.decision, "VERIFIED");
  assert.equal(first.quorum.contractAddress, CONTRACT_ADDRESS);
  assert.equal(first.quorum.transactionHash, QUORUM_TRANSACTION_HASH);
  assert.equal(first.quorum.blockNumber, 4321);
  assert.equal(first.files[0].ocr.amount.value, "1250000");
  assert.equal(first.files[0].screening.screeningStatus, "CLEAR");
  assert.equal(JSON.stringify(first).includes("extracted"), false);
  assert.equal(JSON.stringify(first).includes("extractedText"), false);
});

test("buildCanonicalPackage rejects a round without a confirmed chain receipt", () => {
  assert.throws(() => buildCanonicalPackage(sourceFixture({ quorumTransactionHash: null })), { code: "PROOF_SOURCE_NOT_READY" });
  assert.throws(() => buildCanonicalPackage(sourceFixture({ blockNumber: null })), { code: "PROOF_SOURCE_NOT_READY" });
  assert.throws(() => buildCanonicalPackage(sourceFixture({ contractAddress: null })), { code: "PROOF_SOURCE_NOT_READY" });
  assert.throws(() => buildCanonicalPackage(sourceFixture({ roundNumber: null })), { code: "PROOF_SOURCE_NOT_READY" });
});

test("buildCanonicalPackage rejects rounds without a decision or without OCR", () => {
  assert.throws(() => buildCanonicalPackage(sourceFixture({ decision: null })), { code: "PROOF_SOURCE_NOT_READY" });
  assert.throws(() => buildCanonicalPackage(sourceFixture({ ocr: null })), { code: "PROOF_SOURCE_NOT_READY" });
  assert.throws(() => buildCanonicalPackage(sourceFixture({
    ocr: sourceFixture().ocr && { ...sourceFixture().ocr, screeningStatus: "PROCESSING" },
  })), { code: "PROOF_SOURCE_NOT_READY" });
});

test("flagged partial OCR still produces a canonical proof with unique flag codes", async () => {
  const repository = createFakeProofRepository();
  repository.getProofSourceData = async () => sourceFixture({
    ocr: {
      ...sourceFixture().ocr,
      amount: "50000", currency: null, invoiceNumber: null,
      fieldConfidence: { vendor: 90, documentDate: 90, amount: 95, invoiceNumber: 0 },
      screeningStatus: "FLAGGED", flagCodes: ["MISSING_FIELD", "MISSING_FIELD", "CURRENCY_UNCERTAIN"],
    },
  });
  const service = createProofService({ repository, now: () => FIXED_NOW });
  const result = await service.handleQuorumFinalized({ reviewRoundId: REVIEW_ROUND_ID });
  assert.equal(result.status, "PENDING");
  const proof = [...repository.proofs.values()][0];
  assert.deepEqual(proof.package.files[0].ocr.amount, { value: null, currency: null, confidence: 0 });
  assert.deepEqual(proof.package.files[0].screening.flagCodes, ["CURRENCY_UNCERTAIN", "MISSING_FIELD"]);
  assert.equal(hashProofPackage(proof.package), proof.packageHash);
});

test("background retry confirms a pending anchor receipt without sending a second transaction", async () => {
  const repository = createFakeProofRepository();
  const contract = createFakeAnchorContract();
  const submit = contract.anchorProof;
  contract.anchorProof = async (...args) => {
    const transaction = await submit(...args);
    transaction.wait = async () => { throw new Error("RPC timeout after broadcast"); };
    return transaction;
  };
  const service = createProofService({ repository, anchorContract: contract, now: () => FIXED_NOW });
  const creation = await service.handleQuorumFinalized({ reviewRoundId: REVIEW_ROUND_ID });
  assert.equal(creation.status, "ANCHORING");
  const results = await service.retryFailedProofs();
  assert.equal(results[0].status, "ANCHORED");
  assert.equal(contract.submitted.length, 1);
});

test("a reverted anchor receipt becomes retryable rather than remaining ANCHORING", async () => {
  const repository = createFakeProofRepository();
  const contract = createFakeAnchorContract({ receipt: { status: 0, blockNumber: 42 } });
  const service = createProofService({ repository, anchorContract: contract, now: () => FIXED_NOW });
  const creation = await service.handleQuorumFinalized({ reviewRoundId: REVIEW_ROUND_ID });
  assert.equal(creation.status, "FAILED");
  assert.equal([...repository.proofs.values()][0].lastErrorCode, "PROOF_ANCHOR_RECEIPT_FAILED");
});

test("a replacement anchor transaction is recovered rather than confirmed under the old hash", async () => {
  const repository = createFakeProofRepository();
  const contract = createFakeAnchorContract();
  const send = contract.anchorProof;
  contract.anchorProof = async (...args) => {
    const transaction = await send(...args);
    transaction.wait = async () => { throw Object.assign(new Error("replaced"), { code: "TRANSACTION_REPLACED", receipt: { status: 1, blockNumber: 42 } }); };
    return transaction;
  };
  const result = await createProofService({ repository, anchorContract: contract, now: () => FIXED_NOW }).handleQuorumFinalized({ reviewRoundId: REVIEW_ROUND_ID });
  assert.equal(result.status, "FAILED");
  assert.equal([...repository.proofs.values()][0].lastErrorCode, "PROOF_ANCHOR_RECEIPT_FAILED");
});

test("the package commits the OCR output; edits to stored OCR text change the hash", () => {
  const base = buildCanonicalPackage(sourceFixture());
  assert.match(base.files[0].ocrOutputHash, /^[0-9a-f]{64}$/);
  const tampered = buildCanonicalPackage(sourceFixture({
    ocr: { ...sourceFixture().ocr, extractedText: "TAMPERED RECEIPT TEXT" },
  }));
  assert.notEqual(tampered.files[0].ocrOutputHash, base.files[0].ocrOutputHash);
  const metaEdit = buildCanonicalPackage(sourceFixture({
    ocr: { ...sourceFixture().ocr, amount: "9999999" },
  }));
  assert.notEqual(metaEdit.files[0].ocrOutputHash, base.files[0].ocrOutputHash);
});

test("handleQuorumFinalized creates the proof and anchors it when the chain is configured", async () => {
  const repository = createFakeProofRepository();
  const contract = createFakeAnchorContract();
  const service = createProofService({ repository, anchorContract: contract, contractAddress: CONTRACT_ADDRESS, now: () => FIXED_NOW });
  const result = await service.handleQuorumFinalized({ reviewRoundId: REVIEW_ROUND_ID });
  assert.equal(result.created, true);
  assert.equal(result.status, "ANCHORED");
  assert.equal(result.blockNumber, 42);
  const proof = [...repository.proofs.values()][0];
  assert.equal(proof.status, "ANCHORED");
  assert.equal(proof.packageSchemaVersion, 2);
  assert.equal(proof.transactionHash, `0x${"ab".repeat(32)}`);
  assert.equal(proof.attempts, 1);
  assert.equal(contract.submitted.length, 1);
  assert.equal(contract.submitted[0].commitment, `0x${proof.packageHash}`);
});

test("handleQuorumFinalized leaves the proof PENDING and idempotent when anchoring is disabled", async () => {
  const repository = createFakeProofRepository();
  const service = createProofService({ repository, now: () => FIXED_NOW });
  const first = await service.handleQuorumFinalized({ reviewRoundId: REVIEW_ROUND_ID });
  assert.equal(first.status, "PENDING");
  assert.equal(first.anchorDisabled, true);
  const second = await service.handleQuorumFinalized({ reviewRoundId: REVIEW_ROUND_ID });
  assert.equal(second.created, false);
  assert.equal(second.status, "PENDING");
});

test("anchorProof marks failures without throwing away review outcomes and retries idempotently", async () => {
  const repository = createFakeProofRepository();
  const contract = createFakeAnchorContract({ failSubmit: true });
  const service = createProofService({ repository, anchorContract: contract, now: () => FIXED_NOW });
  const creation = await service.handleQuorumFinalized({ reviewRoundId: REVIEW_ROUND_ID });
  assert.equal(creation.status, "FAILED");

  const working = createFakeAnchorContract();
  const retryService = createProofService({ repository, anchorContract: working, now: () => FIXED_NOW });
  const retried = await retryService.anchorProof(creation.proofId);
  assert.equal(retried.status, "ANCHORED");
  assert.equal(retried.attempted, true);
  const again = await retryService.anchorProof(creation.proofId);
  assert.equal(again.status, "ANCHORED");
  assert.equal(again.attempted, false);
  assert.equal(working.submitted.length, 1);
});

test("anchorProof recovers when the commitment is already on-chain with a stored transaction", async () => {
  const repository = createFakeProofRepository();
  const contract = createFakeAnchorContract();
  const service = createProofService({ repository, anchorContract: contract, now: () => FIXED_NOW });
  const creation = await service.handleQuorumFinalized({ reviewRoundId: REVIEW_ROUND_ID });
  assert.equal(creation.status, "ANCHORED");

  const crashRepository = createFakeProofRepository();
  const proofRow = { ...[...repository.proofs.values()][0], status: "ANCHORING" };
  crashRepository.proofs.set(`evidence:${proofRow.evidenceId}`, proofRow);
  const recoveringContract = createFakeAnchorContract({ commitments: contract.commitments });
  const recovering = createProofService({ repository: crashRepository, anchorContract: recoveringContract, now: () => FIXED_NOW });
  const result = await recovering.anchorProof(creation.proofId);
  assert.equal(result.status, "ANCHORED");
  assert.equal(result.blockNumber, 42);
  assert.equal(recoveringContract.submitted.length, 0);
});

test("retryFailedProofs skips when disabled and reports per-proof failures", async () => {
  const repository = createFakeProofRepository();
  const service = createProofService({ repository, now: () => FIXED_NOW });
  assert.deepEqual(await service.retryFailedProofs(), []);

  const contract = createFakeAnchorContract({ failSubmit: true });
  const failing = createProofService({ repository, anchorContract: contract, maxAttempts: 2, now: () => FIXED_NOW });
  await failing.handleQuorumFinalized({ reviewRoundId: REVIEW_ROUND_ID });
  const results = await failing.retryFailedProofs();
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "PROOF_ANCHOR_TRANSACTION_FAILED");
  await assert.rejects(() => failing.anchorProof([...repository.proofs.values()][0].proofId), { code: "PROOF_RETRY_LIMIT_EXCEEDED" });
});

test("projectProof hides all detail from Funders and exposes metadata to Admin and Organizer", () => {
  const repository = createFakeProofRepository();
  const service = createProofService({ repository, now: () => FIXED_NOW });
  const proof = {
    proofId: `0x${"12".repeat(32)}`,
    proofVersion: 1,
    status: "ANCHORED",
    createdAt: FIXED_NOW,
    evidenceId: EVIDENCE_ID,
    campaignId: CAMPAIGN_ID,
    milestoneId: MILESTONE_ID,
    packageHash: `${"12".repeat(32)}`,
    contractAddress: `0x${"c".repeat(40)}`,
    transactionHash: `0x${"ab".repeat(32)}`,
    blockNumber: 42,
    attempts: 1,
    lastErrorCode: null,
    anchoredAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
  assert.deepEqual(Object.keys(service.projectProof(proof, "FUNDER")).sort(),
    ["createdAt", "proofId", "proofVersion", "status"]);
  assert.equal(service.projectProof(proof, "ADMIN").packageHash, proof.packageHash);
  assert.equal(service.projectProof(proof, "ORGANIZER").transactionHash, proof.transactionHash);
  assert.equal(service.projectProof(null, "ADMIN"), null);
});
