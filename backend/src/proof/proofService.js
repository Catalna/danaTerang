import { hashOcrOutput, hashProofPackage, normalizeProofPackage } from "@dana-terang/proof";

const ZERO_COMMITMENT = `0x${"00".repeat(32)}`;
const VERIFICATION_STATUSES = new Set(["VERIFIED", "NEEDS_REVISION", "REJECTED"]);
const SCREENING_STATUSES = new Set(["CLEAR", "FLAGGED", "FAILED"]);
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-f]{64}$/i;
const CONTRACT_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;
const PACKAGE_SCHEMA_VERSION = 2;

function proofError(code) {
  return Object.assign(new Error(code), { code });
}

function isoMilliseconds(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
  const result = value.toISOString();
  return ISO_TIMESTAMP_PATTERN.test(result) ? result : null;
}

function documentDateString(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null;
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function confidence(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100 ? value : 0;
}

function chainReference(value, pattern) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!pattern.test(normalized) || /^0x0+$/.test(normalized)) return null;
  return normalized;
}

export function buildCanonicalPackage(source) {
  if (!source || source.decision === null || !VERIFICATION_STATUSES.has(source.decision)
      || !source.completedAt) {
    throw proofError("PROOF_SOURCE_NOT_READY");
  }
  const reviewedAt = source.completedAt instanceof Date ? isoMilliseconds(source.completedAt) : String(source.completedAt);
  if (!reviewedAt) throw proofError("PROOF_SOURCE_NOT_READY");

  const quorum = {
    reviewRef: chainReference(source.reviewId, TRANSACTION_HASH_PATTERN),
    roundNumber: Number.isSafeInteger(source.roundNumber) && source.roundNumber >= 1 ? source.roundNumber : null,
    decision: source.decision,
    contractAddress: chainReference(source.contractAddress, CONTRACT_ADDRESS_PATTERN),
    transactionHash: chainReference(source.quorumTransactionHash, TRANSACTION_HASH_PATTERN),
    blockNumber: Number.isSafeInteger(source.blockNumber) && source.blockNumber >= 0 ? source.blockNumber : null,
  };
  if (!quorum.reviewRef || !quorum.contractAddress || !quorum.transactionHash
      || quorum.roundNumber === null || quorum.blockNumber === null) {
    throw proofError("PROOF_SOURCE_NOT_READY");
  }

  const ocr = source.ocr;
  if (!ocr || !SCREENING_STATUSES.has(ocr.screeningStatus)) {
    throw proofError("PROOF_SOURCE_NOT_READY");
  }
  // The proof schema represents money only as a complete amount/currency pair.
  // Keep partial readings in the private OCR record and commit their screening flags.
  const hasMoney = ocr.amount != null && ocr.currency != null;
  const amountValue = hasMoney ? ocr.amount : null;
  const currencyValue = hasMoney ? ocr.currency : null;
  const vendor = ocr.vendor ?? null;
  const documentDate = documentDateString(ocr.documentDate);
  const invoiceNumber = ocr.invoiceNumber ?? null;

  // Commit the full OCR/AI output (including the raw extracted text) without
  // publishing it: only this hash enters the on-chain-anchored package, so any
  // later edit of the stored OCR result breaks the commitment.
  const ocrOutputRecord = {
    evidenceId: String(source.evidenceId).toLowerCase(),
    runNumber: Number.isSafeInteger(ocr.runNumber) ? ocr.runNumber : null,
    detectedLanguage: ocr.detectedLanguage,
    vendor,
    documentDate,
    amount: { value: amountValue, currency: currencyValue },
    invoiceNumber,
    fieldConfidence: {
      vendor: confidence(ocr.fieldConfidence?.vendor),
      documentDate: confidence(ocr.fieldConfidence?.documentDate),
      amount: confidence(ocr.fieldConfidence?.amount),
      invoiceNumber: confidence(ocr.fieldConfidence?.invoiceNumber),
    },
    screeningStatus: ocr.screeningStatus,
    flagCodes: [...new Set((ocr.flagCodes ?? []).map((code) => String(code).toUpperCase()))].sort(),
    extractedText: typeof ocr.extractedText === "string" ? ocr.extractedText : "",
    failureCode: ocr.failureCode ?? null,
    ai: ocr.ai ? {
      model: ocr.ai.model ?? null,
      status: ocr.ai.status ?? null,
      enrichment: ocr.ai.enrichment ?? null,
    } : null,
  };

  const packageInput = {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    campaignId: String(source.campaignId).toLowerCase(),
    milestoneId: String(source.milestoneId).toLowerCase(),
    evidenceVersion: source.evidenceVersion,
    createdAt: source.now,
    quorum,
    files: [{
      evidenceId: String(source.evidenceId).toLowerCase(),
      evidenceType: source.evidenceType,
      rawHash: String(source.rawHash).toLowerCase(),
      redactedHash: null,
      ocr: {
        language: ocr.detectedLanguage,
        vendor: { value: vendor, confidence: vendor === null ? 0 : confidence(ocr.fieldConfidence?.vendor) },
        documentDate: { value: documentDate, confidence: documentDate === null ? 0 : confidence(ocr.fieldConfidence?.documentDate) },
        amount: { value: amountValue, currency: currencyValue, confidence: hasMoney ? confidence(ocr.fieldConfidence?.amount) : 0 },
        invoiceNumber: { value: invoiceNumber, confidence: invoiceNumber === null ? 0 : confidence(ocr.fieldConfidence?.invoiceNumber) },
      },
      screening: {
        screeningStatus: ocr.screeningStatus,
        flagCodes: [...new Set((ocr.flagCodes ?? []).map((code) => String(code).toUpperCase()))].sort(),
      },
      ocrOutputHash: hashOcrOutput(ocrOutputRecord),
    }],
    verification: {
      verificationStatus: source.decision,
      reviewedAt,
      verifierRef: String(source.reviewId).toLowerCase(),
    },
    proofVersion: 1,
  };
  return packageInput;
}

export function createProofService({ repository, anchorContract = null, contractAddress = null, maxAttempts = 8, now: clock = () => new Date() } = {}) {
  if (!repository) throw new TypeError("Proof service requires a repository");

  async function buildPackage(reviewRoundId, createdAt = clock()) {
    const source = await repository.getProofSourceData(reviewRoundId);
    const now = isoMilliseconds(createdAt);
    if (!now) throw proofError("INVALID_PROOF_TIME");
    const input = normalizeProofPackage(buildCanonicalPackage({ ...source, now }));
    const packageHash = hashProofPackage(input);
    return { source, input, packageHash, proofId: `0x${packageHash}` };
  }

  async function handleQuorumFinalized({ reviewRoundId, now = clock() } = {}) {
    const { source, input, packageHash, proofId } = await buildPackage(reviewRoundId, now);
    const created = await repository.createProofForRound({
      evidenceId: source.evidenceId,
      reviewRoundId,
      proofVersion: 1,
      packageSchemaVersion: PACKAGE_SCHEMA_VERSION,
      campaignId: source.campaignId,
      milestoneId: source.milestoneId,
      canonicalPackage: input,
      packageHash,
      now,
    });
    if (!created.created) {
      return { proofId: created.proof.proofId, status: created.proof.status, created: false, attempted: false };
    }
    if (!anchorContract) {
      return { proofId, status: "PENDING", created: true, attempted: false, anchorDisabled: true };
    }
    try {
      const anchored = await anchorProof(proofId, { now });
      return { proofId, created: true, ...anchored };
    } catch (error) {
      const current = await repository.findProofByProofId(proofId);
      return {
        proofId,
        created: true,
        attempted: false,
        status: current?.status ?? "FAILED",
        anchorError: error?.code ?? "PROOF_ANCHOR_FAILED",
      };
    }
  }

  async function anchorProof(proofId, { now = clock() } = {}) {
    const proof = await repository.findProofByProofId(proofId);
    if (!proof) throw proofError("PROOF_NOT_FOUND");
    if (proof.status === "ANCHORED") return { status: "ANCHORED", attempted: false };

    if (!anchorContract) throw proofError("PROOF_ANCHOR_DISABLED");

    if (proof.status === "ANCHORING") {
      if (!proof.transactionHash && now.getTime() - new Date(proof.updatedAt).getTime() < 300_000) {
        return { status: "ANCHORING", attempted: false };
      }
      return recoverAnchoring(proof, now);
    }

    if (proof.attempts >= maxAttempts) throw proofError("PROOF_RETRY_LIMIT_EXCEEDED");
    await repository.markAnchoring({ proofId, now });

    const commitment = `0x${proof.packageHash}`;
    let onChain;
    try {
      onChain = String(await anchorContract.proofCommitments(proofId)).toLowerCase();
    } catch {
      await repository.markFailed({ proofId, errorCode: "PROOF_ANCHOR_READ_FAILED", now });
      throw proofError("PROOF_ANCHOR_READ_FAILED");
    }
    if (onChain !== ZERO_COMMITMENT) {
      if (onChain === commitment) return recoverAnchoring(await repository.findProofByProofId(proofId), now);
      await repository.markFailed({ proofId, errorCode: "PROOF_COMMITMENT_MISMATCH", now });
      throw proofError("PROOF_COMMITMENT_MISMATCH");
    }

    let transaction;
    try {
      transaction = await anchorContract.anchorProof(proofId, commitment);
    } catch {
      await repository.markFailed({ proofId, errorCode: "PROOF_ANCHOR_TRANSACTION_FAILED", now });
      throw proofError("PROOF_ANCHOR_TRANSACTION_FAILED");
    }
    const transactionHash = typeof transaction?.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(transaction.hash)
      ? transaction.hash.toLowerCase()
      : null;
    if (!transactionHash) {
      await repository.markFailed({ proofId, errorCode: "PROOF_ANCHOR_TRANSACTION_FAILED", now });
      throw proofError("PROOF_ANCHOR_TRANSACTION_FAILED");
    }
    await repository.markAnchorSubmitted({ proofId, contractAddress, transactionHash, now });

    let receipt;
    try {
      receipt = await transaction.wait(1, 60_000);
    } catch (error) {
      if (error?.code === "TRANSACTION_REPLACED" || error?.receipt && Number(error.receipt.status) === 0) {
        await repository.markFailed({ proofId, errorCode: "PROOF_ANCHOR_RECEIPT_FAILED", now });
        throw proofError("PROOF_ANCHOR_RECEIPT_FAILED");
      }
      throw proofError("PROOF_ANCHOR_RECEIPT_PENDING");
    }
    if (Number(receipt?.status) !== 1 || !Number.isSafeInteger(Number(receipt.blockNumber)) || Number(receipt.blockNumber) < 0) {
      await repository.markFailed({ proofId, errorCode: "PROOF_ANCHOR_RECEIPT_FAILED", now });
      throw proofError("PROOF_ANCHOR_RECEIPT_FAILED");
    }
    const anchored = await repository.markAnchored({ proofId, blockNumber: Number(receipt.blockNumber), anchoredAt: now });
    return { status: anchored.status, attempted: true, transactionHash, blockNumber: anchored.blockNumber };
  }

  async function recoverAnchoring(proof, now) {
    const commitment = `0x${proof.packageHash}`;
    let onChain;
    try {
      onChain = String(await anchorContract.proofCommitments(proof.proofId)).toLowerCase();
    } catch {
      throw proofError("PROOF_ANCHOR_READ_FAILED");
    }
    if (onChain === ZERO_COMMITMENT) {
      if (!proof.transactionHash) {
        await repository.markFailed({ proofId: proof.proofId, errorCode: "PROOF_ANCHOR_INTERRUPTED", now });
        return { status: "FAILED", attempted: false };
      }
      const receipt = await anchorContract.runner?.provider?.getTransactionReceipt(proof.transactionHash);
      if (receipt && Number(receipt.status) === 0) {
        await repository.markFailed({ proofId: proof.proofId, errorCode: "PROOF_ANCHOR_RECEIPT_FAILED", now });
        return { status: "FAILED", attempted: false };
      }
      return { status: proof.status, attempted: false };
    }
    if (onChain !== commitment) {
      await repository.markFailed({ proofId: proof.proofId, errorCode: "PROOF_COMMITMENT_MISMATCH", now });
      throw proofError("PROOF_COMMITMENT_MISMATCH");
    }
    if (!proof.transactionHash && typeof anchorContract.queryFilter === "function" && anchorContract.filters?.ProofAnchored) {
      const events = await anchorContract.queryFilter(anchorContract.filters.ProofAnchored(proof.proofId), 0, "latest");
      const event = events.find((entry) => String(entry.args?.commitment ?? entry.args?.[1]).toLowerCase() === commitment);
      const transactionHash = event?.transactionHash ?? event?.log?.transactionHash;
      if (transactionHash) proof = await repository.markAnchorSubmitted({ proofId: proof.proofId, contractAddress, transactionHash, now });
    }
    if (!proof.transactionHash) throw proofError("PROOF_ANCHOR_RECEIPT_UNAVAILABLE");
    let blockNumber = proof.blockNumber;
    if (!Number.isSafeInteger(blockNumber)) {
      try {
        const receipt = await anchorContract.runner?.provider?.getTransactionReceipt(proof.transactionHash);
        if (receipt && Number(receipt.status) === 1 && Number.isSafeInteger(Number(receipt.blockNumber)) && Number(receipt.blockNumber) >= 0) {
          blockNumber = Number(receipt.blockNumber);
        }
      } catch { /* Fall through to the receipt-unavailable guard below. */ }
    }
    if (!Number.isSafeInteger(blockNumber)) throw proofError("PROOF_ANCHOR_RECEIPT_PENDING");
    const anchored = await repository.markAnchored({ proofId: proof.proofId, blockNumber, anchoredAt: now });
    return { status: anchored.status, attempted: true, transactionHash: proof.transactionHash, blockNumber: anchored.blockNumber };
  }

  async function retryFailedProofs({ limit = 50, now = clock() } = {}) {
    if (!anchorContract) return [];
    const pending = await repository.listAnchorableProofs({ limit, maxAttempts });
    const results = [];
    for (const proof of pending) {
      try {
        results.push({ proofId: proof.proofId, ...(await anchorProof(proof.proofId, { now })) });
      } catch (error) {
        const errorCode = error?.code ?? "PROOF_ANCHOR_FAILED";
        results.push({ proofId: proof.proofId, status: errorCode, errorCode, attempted: true });
      }
    }
    return results;
  }

  async function createMissingProofs({ limit = 50, now = clock() } = {}) {
    const rounds = await repository.listFinalizedRoundsWithoutProof({ limit });
    const results = [];
    for (const { reviewRoundId } of rounds) {
      try {
        results.push({ reviewRoundId, ...(await handleQuorumFinalized({ reviewRoundId, now })) });
      } catch (error) {
        results.push({ reviewRoundId, errorCode: error?.code ?? "PROOF_CREATION_FAILED" });
      }
    }
    return results;
  }

  function projectProof(proof, viewer) {
    if (!proof) return null;
    const base = {
      proofId: proof.proofId,
      proofVersion: proof.proofVersion,
      status: proof.status,
      createdAt: proof.createdAt,
    };
    if (viewer === "FUNDER") return base;
    return {
      ...base,
      evidenceId: proof.evidenceId,
      campaignId: proof.campaignId,
      milestoneId: proof.milestoneId,
      packageHash: proof.packageHash,
      contractAddress: proof.contractAddress,
      transactionHash: proof.transactionHash,
      blockNumber: proof.blockNumber,
      attempts: proof.attempts,
      lastErrorCode: proof.lastErrorCode,
      anchoredAt: proof.anchoredAt,
      updatedAt: proof.updatedAt,
    };
  }

  return Object.freeze({
    handleQuorumFinalized,
    anchorProof,
    retryFailedProofs,
    createMissingProofs,
    buildPackage,
    projectProof,
  });
}
