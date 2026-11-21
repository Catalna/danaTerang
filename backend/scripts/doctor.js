import "dotenv/config";
import { readApiConfig, readEvidenceLimit } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { readOcrConfig } from "../src/ocr/config.js";
import { readPeerReviewConfig } from "../src/review/config.js";
import { createPeerReviewChain } from "../src/review/chain.js";
import { readProofAnchorConfig } from "../src/proof/config.js";
import { createProofAnchorChain } from "../src/proof/anchorChain.js";
import { createObjectStorage } from "../src/storage/objectStorage.js";
import { readStorageConfig } from "../src/storage/config.js";
import { createReadinessService } from "../src/runtime/readiness.js";

// Inspects prerequisites only: no migrations, bootstrap, worker jobs or chain writes.
let pool;
let peerReviewChain;
let proofAnchorChain;
let storage;
try {
  const api = readApiConfig();
  const ocr = readOcrConfig();
  readEvidenceLimit();
  storage = createObjectStorage(readStorageConfig());
  const review = readPeerReviewConfig();
  const proof = readProofAnchorConfig();
  if (api.databaseUrl) pool = createPool(api.databaseUrl);
  if (review) {
    try { peerReviewChain = await createPeerReviewChain(review); }
    catch { peerReviewChain = { unavailable: true }; }
  }
  if (proof) {
    try { proofAnchorChain = await createProofAnchorChain(proof); }
    catch { proofAnchorChain = { unavailable: true }; }
  }
  const report = await createReadinessService({ pool, storage, languageDataPath: ocr.languageDataPath, peerReviewChain, proofAnchorChain }).check();
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "ready") process.exitCode = 1;
} catch (error) {
  const code = /^[A-Z0-9_]{1,64}$/.test(error?.code ?? "") ? error.code : "SETUP_CHECK_FAILED";
  console.error(JSON.stringify({ status: "not_ready", error: code }));
  process.exitCode = 1;
} finally {
  await Promise.allSettled([peerReviewChain?.close?.(), proofAnchorChain?.close?.(), storage?.close?.(), pool?.end()]);
}
