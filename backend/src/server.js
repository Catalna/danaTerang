import "dotenv/config";

import { createApp } from "./app.js";
import { readApiConfig, readEvidenceLimit } from "./config.js";
import { readOcrConfig } from "./ocr/config.js";
import { createAiEnricher } from "./ocr/aiEnricher.js";
import { createDocumentRasterizer } from "./ocr/documentRasterizer.js";
import { createOcrWorker } from "./ocr/ocrWorker.js";
import { createTesseractEngine } from "./ocr/tesseractEngine.js";
import { readMigrationStatus, runMigrations } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { readPeerReviewConfig } from "./review/config.js";
import { createPeerReviewChain } from "./review/chain.js";
import { createPeerReviewService } from "./review/peerReviewService.js";
import { readCampaignRegistryConfig } from "./funding/config.js";
import { readProofAnchorConfig } from "./proof/config.js";
import { createCampaignRegistryChain } from "./funding/registry.js";
import { createProofAnchorChain } from "./proof/anchorChain.js";
import { createProofService } from "./proof/proofService.js";
import { createFundingService } from "./funding/fundingService.js";
import { createFundraisingService } from "./fundraising/fundraisingService.js";
import { createSimulatedPaymentProvider } from "./fundraising/simulatedPaymentProvider.js";
import { createObjectStorage } from "./storage/objectStorage.js";
import { readStorageConfig } from "./storage/config.js";
import { createReadinessService } from "./runtime/readiness.js";
import { createAuthRepository } from "./repositories/authRepository.js";
import { createCampaignRepository } from "./repositories/campaignRepository.js";
import { createEvidenceRepository } from "./repositories/evidenceRepository.js";
import { createOcrRepository } from "./repositories/ocrRepository.js";
import { createFundingRepository } from "./repositories/fundingRepository.js";
import { createProofRepository } from "./repositories/proofRepository.js";
import { createReviewRepository } from "./repositories/reviewRepository.js";
import { createPaymentRepository } from "./repositories/paymentRepository.js";
import { createFundraisingRepository } from "./fundraising/fundraisingRepository.js";
import { createWorkflowWorker } from "./workers/workflowWorker.js";

async function startServer() {
  const config = readApiConfig();
  const peerReviewConfig = readPeerReviewConfig();
  const proofAnchorConfig = readProofAnchorConfig();
  const campaignRegistryConfig = readCampaignRegistryConfig();
  const storageConfig = config.databaseUrl ? readStorageConfig() : null;
  const ocrConfig = config.databaseUrl ? readOcrConfig() : null;
  const maxEvidenceBytes = readEvidenceLimit();
  let pool = null;
  let server = null;
  let ocrWorker = null;
  let peerReviewChain = null;
  let proofAnchorChain = null;
  let campaignRegistryChain = null;
  let workflowWorker = null;
  let objectStorage = null;

  try {
    if (peerReviewConfig && !config.databaseUrl) {
      throw Object.assign(new Error("Peer review requires a configured database"), { code: "PEER_REVIEW_DATABASE_REQUIRED" });
    }
    if (proofAnchorConfig && !config.databaseUrl) {
      throw Object.assign(new Error("Proof anchoring requires a configured database"), { code: "PROOF_ANCHOR_DATABASE_REQUIRED" });
    }
    if (config.databaseUrl) {
      pool = createPool(config.databaseUrl);
      await pool.query("SELECT 1");
      if (config.autoMigrate) {
        const applied = await runMigrations(pool);
        console.log(`Development startup applied ${applied.length} database migration(s).`);
      }
      if ((await readMigrationStatus(pool)).pending.length > 0) {
        throw Object.assign(new Error("Run npm run db:migrate --workspace @dana-terang/api before starting the API"), { code: "DATABASE_MIGRATIONS_REQUIRED" });
      }
    }

    if (pool && peerReviewConfig) peerReviewChain = await createPeerReviewChain(peerReviewConfig);
    if (pool && campaignRegistryConfig) {
      campaignRegistryChain = await createCampaignRegistryChain(campaignRegistryConfig, {
        walletFactory: peerReviewChain ? () => peerReviewChain.wallet : undefined,
      });
    }
    if (pool && proofAnchorConfig) proofAnchorChain = await createProofAnchorChain(proofAnchorConfig,
      peerReviewChain ? { walletFactory: () => peerReviewChain.wallet } : undefined);
    const authRepository = pool ? createAuthRepository(pool) : undefined;
    const campaignRepository = pool ? createCampaignRepository(pool) : undefined;
    const reviewRepository = pool && peerReviewChain
      ? createReviewRepository(pool, { contractAddress: peerReviewChain.contractAddress })
      : undefined;
    const proofRepository = pool ? createProofRepository(pool) : undefined;
    const proofService = pool
      ? createProofService({
        repository: proofRepository,
        anchorContract: proofAnchorChain?.contract ?? null,
        contractAddress: proofAnchorChain?.contractAddress ?? null,
      })
      : undefined;
    const peerReviewService = peerReviewChain
      ? createPeerReviewService({
        repository: reviewRepository,
        contract: peerReviewChain.contract,
        chainId: peerReviewConfig.chainId,
        contractAddress: peerReviewChain.contractAddress,
        onQuorumFinalized: proofService
          ? ({ reviewRoundId, now }) => proofService.handleQuorumFinalized({ reviewRoundId, now })
          : null,
      })
      : undefined;
    const fundingRepository = pool ? createFundingRepository(pool) : undefined;
    const fundingService = pool && campaignRegistryChain
      ? createFundingService({
        repository: fundingRepository,
        campaignRepository,
        walletLookup: (userId) => authRepository.getWalletAddress(userId),
        contract: campaignRegistryChain.contract,
        chainId: campaignRegistryConfig.chainId,
        contractAddress: campaignRegistryChain.contractAddress,
      })
      : undefined;
    const fundraisingRepository = pool ? createFundraisingRepository(pool) : undefined;
    // Local development uses a clearly labelled fake provider with no real money
    // movement. Production remains fail-closed until a real provider is selected.
    const fundraisingPaymentProvider = ["development", "test"].includes(config.nodeEnv)
      ? createSimulatedPaymentProvider({ webOrigin: config.webOrigin })
      : null;
    const fundraisingService = fundraisingRepository
      ? createFundraisingService({ repository: fundraisingRepository, paymentProvider: fundraisingPaymentProvider })
      : undefined;
    const evidenceRepository = pool ? createEvidenceRepository(pool, { reviewRepository }) : undefined;
    const ocrRepository = pool ? createOcrRepository(pool, {
      reviewRepository,
      onReviewError: ({ code }) => console.error(`OCR review handoff deferred: ${code}`),
    }) : undefined;
    objectStorage = pool ? createObjectStorage(storageConfig) : undefined;
    await objectStorage?.initialize?.();
    if (pool && objectStorage && ocrRepository && ocrConfig) {
      // Inject a real sleep so API-failure retries honor the configured backoff
      // (tests inject a fake clock; without this production retries immediately).
      const enricher = createAiEnricher({
        config: ocrConfig.gemini,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
      ocrWorker = createOcrWorker({
        repository: ocrRepository,
        storage: objectStorage,
        renderer: createDocumentRasterizer(),
        engine: createTesseractEngine({ languageDataPath: ocrConfig.languageDataPath }),
        enricher,
        aiMaxPages: ocrConfig.gemini.maxPages,
        thresholds: ocrConfig.thresholds,
        pollIntervalMs: ocrConfig.pollIntervalMs,
        leaseMs: ocrConfig.leaseMs,
        maxAttempts: ocrConfig.maxAttempts,
        maxPdfPages: ocrConfig.maxPdfPages,
        renderDpi: ocrConfig.renderDpi,
        maxImagePixels: ocrConfig.maxImagePixels,
        maxEvidenceBytes,
        onError: ({ code }) => console.error(`OCR background worker error: ${code}`),
      });
    }
    workflowWorker = createWorkflowWorker({
      reviewRepository, peerReviewService, proofService, fundraisingService,
      onError: ({ stage, code }) => console.error(`Workflow recovery ${stage}: ${code}`),
    });
    const readinessService = createReadinessService({
      pool, storage: objectStorage, languageDataPath: ocrConfig?.languageDataPath,
      peerReviewChain, proofAnchorChain,
      isOcrRunning: () => ocrWorker?.getStatus().running ?? false,
      isWorkflowRunning: () => workflowWorker.getStatus().running,
    });
    server = createApp({
      authRepository,
      campaignRepository,
      paymentRepository: pool ? createPaymentRepository(pool) : undefined,
      fundraisingService,
      evidenceRepository,
      reviewRepository,
      peerReviewService,
      proofRepository,
      proofService,
      fundingRepository,
      fundingService,
      readinessService,
      objectStorage,
      maxEvidenceBytes,
      webOrigin: config.webOrigin,
      nodeEnv: config.nodeEnv,
    })
      .listen(config.port, config.host);
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });

    console.log(`DanaTerang API listening on ${config.host}:${config.port}${pool ? " with PostgreSQL" : " in health-only mode"}.`);
    console.log(`AI OCR enrichment: ${ocrConfig?.gemini.enabled ? `enabled (model ${ocrConfig.gemini.model}, max ${ocrConfig.gemini.maxPages} pages)` : "disabled"}.`);
    if (ocrWorker) {
      ocrWorker.start().catch(() => {
        console.error("OCR background worker stopped unexpectedly.");
        process.exitCode = 1;
      });
    }
    workflowWorker.start();

    let shuttingDown = false;
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => {
        if (shuttingDown) return;
        shuttingDown = true;
        server.close(async (error) => {
          const workers = await Promise.allSettled([ocrWorker?.stop(), workflowWorker?.stop()]);
          const resources = await Promise.allSettled([peerReviewChain?.close(), proofAnchorChain?.close(), objectStorage?.close?.(), pool?.end()]);
          if (error || [...workers, ...resources].some((result) => result.status === "rejected")) {
            console.error("DanaTerang API shutdown encountered an error.");
            process.exitCode = 1;
          }
        });
      });
    }
  } catch (error) {
    if (server?.listening) server.close();
    await Promise.allSettled([ocrWorker?.stop(), workflowWorker?.stop()]);
    await Promise.allSettled([peerReviewChain?.close(), proofAnchorChain?.close(), objectStorage?.close?.(), pool?.end()]);
    throw error;
  }
}

startServer().catch((error) => {
  console.error("DanaTerang API startup failed:", error);
  process.exitCode = 1;
});
