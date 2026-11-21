import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createOcrWorker } from "../../src/ocr/ocrWorker.js";
import { createAiEnricher } from "../../src/ocr/aiEnricher.js";
import { readOcrConfig } from "../../src/ocr/config.js";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const JOB = {
  jobId: "job-1",
  runId: "run-1",
  runNumber: 1,
  evidenceId: "evidence-1",
  storageKey: "00000000-0000-4000-8000-000000000001",
  rawHash: createHash("sha256").update("private bytes").digest("hex"),
  fileSize: Buffer.byteLength("private bytes"),
  milestoneBudget: "100000.00",
  milestoneCurrency: "IDR",
  campaignStartDate: "2026-01-01",
  campaignEndDate: "2026-12-31",
};

const ENGINE_TEXT = "TOKO MAJU\nInvoice Date: 01 Oct 2026\nInvoice No: INV-2026-01\nTotal: Rp 150.000";

function workerDependencies({ renderPageCount = 1, weakAmount = true } = {}) {
  const calls = { reads: [], recognized: [], enrichments: [], duplicates: [], completions: [], failures: [] };
  const repository = {
    async claimNextJob() { return JOB; },
    async renewLease() { return true; },
    async findDuplicateCandidates(input) { calls.duplicates.push(input); return []; },
    async completeRun(input) { calls.completions.push(input); },
    async failRun(input) { calls.failures.push(input); },
  };
  const storage = { async readObject() { calls.reads.push(1); return Buffer.from("private bytes"); } };
  const renderer = {
    async *renderEvidencePages() {
      for (let index = 1; index <= renderPageCount; index += 1) yield { pageNumber: index, bytes: Buffer.from(`page-${index}`), width: 100, height: 100 };
    },
  };
  const engine = {
    async initialize() {},
    async recognize(bytes) {
      calls.recognized.push(bytes.toString());
      return {
        text: ENGINE_TEXT,
        words: weakAmount
          ? [
            { text: "TOKO", confidence: 95 }, { text: "MAJU", confidence: 95 },
            { text: "01", confidence: 95 }, { text: "Oct", confidence: 95 }, { text: "2026", confidence: 95 },
            { text: "INV-2026-01", confidence: 95 }, { text: "150.000", confidence: 20 },
          ]
          : [
            { text: "TOKO", confidence: 95 }, { text: "MAJU", confidence: 95 },
            { text: "01", confidence: 95 }, { text: "Oct", confidence: 95 }, { text: "2026", confidence: 95 },
            { text: "INV-2026-01", confidence: 95 }, { text: "150.000", confidence: 95 },
          ],
      };
    },
    async close() {},
  };
  return { calls, repository, storage, renderer, engine };
}

function syntheticEnricher(calls, behavior) {
  return {
    enrich(input) {
      calls.enrichments.push(input);
      return behavior(input);
    },
  };
}

test("worker feeds strongest merged fields into dedupe and screening", async () => {
  const dependencies = workerDependencies();
  const enricher = syntheticEnricher(dependencies.calls, (input) => ({
    merged: { ...input.parsed, amount: "50000", fieldConfidence: { ...input.parsed.fieldConfidence, amount: 95 } },
    ai: { status: "APPLIED", reason: null, model: "gemini-2.5-flash", fields: {} },
  }));
  const worker = createOcrWorker({ ...dependencies, enricher, aiMaxPages: 4, workerId: "worker-1", clock: () => NOW });
  try {
    await worker.runOnce();
    assert.equal(dependencies.calls.enrichments.length, 1);
    assert.equal(dependencies.calls.duplicates.length, 1);
    const completion = dependencies.calls.completions[0];
    assert.equal(completion.result.screeningStatus, "CLEAR");
    assert.equal(completion.result.parsed.amount, "50000");
    assert.equal(completion.result.ai.status, "APPLIED");
    assert.equal(dependencies.calls.failures.length, 0);
  } finally {
    await worker.stop();
  }
});

test("worker forwards captured page buffers up to the AI page cap", async () => {
  const dependencies = workerDependencies({ renderPageCount: 3 });
  const enricher = syntheticEnricher(dependencies.calls, (input) => ({ merged: input.parsed, ai: { status: "APPLIED" } }));
  const worker = createOcrWorker({ ...dependencies, enricher, aiMaxPages: 2, workerId: "worker-1", clock: () => NOW });
  try {
    await worker.runOnce();
    assert.equal(dependencies.calls.enrichments.length, 1);
    const enrichmentInput = dependencies.calls.enrichments[0];
    assert.deepEqual(enrichmentInput.pages, [Buffer.from("page-1"), Buffer.from("page-2")]);
    assert.ok(enrichmentInput.text.includes("TOKO MAJU"));
    assert.equal(enrichmentInput.parsed.amount, "150000");
  } finally {
    await worker.stop();
  }
});

test("worker keeps the legacy pipeline unchanged without an enricher", async () => {
  const dependencies = workerDependencies();
  const worker = createOcrWorker({ ...dependencies, workerId: "worker-1", clock: () => NOW });
  try {
    await worker.runOnce();
    assert.equal(dependencies.calls.enrichments.length, 0);
    const completion = dependencies.calls.completions[0];
    assert.equal(completion.result.ai, undefined);
    assert.equal(completion.result.screeningStatus, "FLAGGED");
    assert.ok(completion.result.flags.some((flag) => flag.code === "AMOUNT_MISMATCH"));
  } finally {
    await worker.stop();
  }
});

test("worker persists an UNAVAILABLE enrichment result without blocking the screening", async () => {
  const dependencies = workerDependencies();
  const enricher = syntheticEnricher(dependencies.calls, (input) => ({
    merged: input.parsed,
    ai: { status: "UNAVAILABLE", reason: "TIMEOUT", model: "gemini-2.5-flash", fields: null },
  }));
  const worker = createOcrWorker({ ...dependencies, enricher, aiMaxPages: 4, workerId: "worker-1", clock: () => NOW });
  try {
    await worker.runOnce();
    const completion = dependencies.calls.completions[0];
    assert.equal(completion.result.ai.status, "UNAVAILABLE");
    assert.equal(completion.result.ai.reason, "TIMEOUT");
    assert.equal(completion.result.screeningStatus, "FLAGGED");
    assert.equal(dependencies.calls.failures.length, 0);
  } finally {
    await worker.stop();
  }
});

test("worker survives an enricher that throws unexpectedly", async () => {
  const dependencies = workerDependencies();
  const enricher = syntheticEnricher(dependencies.calls, () => { throw new Error("boom"); });
  const worker = createOcrWorker({ ...dependencies, enricher, aiMaxPages: 4, workerId: "worker-1", clock: () => NOW });
  try {
    await worker.runOnce();
    const completion = dependencies.calls.completions[0];
    assert.equal(completion.result.parsed.amount, "150000");
    assert.equal(completion.result.ai.status, "UNAVAILABLE");
    assert.equal(completion.result.ai.reason, "ENRICHER_FAILURE");
    assert.equal(dependencies.calls.failures.length, 0);
  } finally {
    await worker.stop();
  }
});

test("worker construction rejects an enricher without an enrich function", () => {
  const dependencies = workerDependencies();
  assert.throws(() => createOcrWorker({ ...dependencies, enricher: {} }), TypeError);
});

function visionEnricher({ available = true } = {}) {
  return createAiEnricher({
    config: readOcrConfig({ GEMINI_ENABLED: "true", GEMINI_API_KEY: "synthetic-test-key", GEMINI_RETRIES: "0" }).gemini,
    async fetchImpl() {
      return {
        status: available ? 200 : 503,
        text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
          vendor: "TOKO MAJU", documentDate: "2026-10-25", amount: "150000", currency: "IDR", invoiceNumber: "INV-01",
          fieldConfidence: { vendor: 99, documentDate: 99, amount: 99, currency: 99, invoiceNumber: 99 }, notes: [],
        }) }] } }] }),
      };
    },
  });
}

test("empty local OCR is recovered with vision while raw text and budget flags are preserved", async () => {
  const dependencies = workerDependencies();
  dependencies.engine.recognize = async () => ({ text: "", words: [] });
  const worker = createOcrWorker({ ...dependencies, enricher: visionEnricher(), clock: () => NOW });
  try {
    await worker.runOnce();
    const result = dependencies.calls.completions[0].result;
    assert.equal(result.parsed.amount, "150000");
    assert.equal(result.parsed.extractedText, "");
    assert.equal(result.ai.fields.amount.source, "gemini");
    assert.equal(result.ai.visionFallback, true);
    assert.ok(result.flags.some(({ code }) => code === "AMOUNT_MISMATCH"));
    assert.equal(dependencies.calls.failures.length, 0);
  } finally { await worker.stop(); }
});

test("vision can recover a missing local engine without changing the original bytes", async () => {
  const dependencies = workerDependencies();
  dependencies.engine.initialize = async () => { throw Object.assign(new Error("missing"), { code: "OCR_LANGUAGE_DATA_MISSING" }); };
  const worker = createOcrWorker({ ...dependencies, enricher: visionEnricher(), clock: () => NOW });
  try {
    await worker.runOnce();
    assert.equal(dependencies.calls.completions[0].result.ai.ocrFailureCode, "OCR_LANGUAGE_DATA_MISSING");
    assert.equal(dependencies.calls.completions[0].result.parsed.extractedText, "");
    assert.equal(dependencies.calls.failures.length, 0);
  } finally { await worker.stop(); }
});

test("a recognition crash is recoverable through vision", async () => {
  const dependencies = workerDependencies();
  dependencies.engine.recognize = async () => { throw Object.assign(new Error("crash"), { code: "OCR_RECOGNITION_FAILED" }); };
  const worker = createOcrWorker({ ...dependencies, enricher: visionEnricher(), clock: () => NOW });
  try {
    await worker.runOnce();
    assert.equal(dependencies.calls.completions[0].result.ai.ocrFailureCode, "OCR_RECOGNITION_FAILED");
    assert.equal(dependencies.calls.failures.length, 0);
  } finally { await worker.stop(); }
});

test("an unavailable vision fallback leaves empty OCR retryable rather than reporting success", async () => {
  const dependencies = workerDependencies();
  dependencies.engine.recognize = async () => ({ text: "", words: [] });
  const worker = createOcrWorker({ ...dependencies, enricher: visionEnricher({ available: false }), clock: () => NOW });
  try {
    await worker.runOnce();
    assert.equal(dependencies.calls.completions.length, 0);
    assert.equal(dependencies.calls.failures[0].failureCode, "OCR_EMPTY_DOCUMENT");
  } finally { await worker.stop(); }
});

test("the worker forwards custom screening thresholds to enrichment", async () => {
  const dependencies = workerDependencies();
  const thresholds = { vendor: 60, documentDate: 75, amount: 85, invoiceNumber: 65 };
  const enricher = syntheticEnricher(dependencies.calls, ({ parsed }) => ({ merged: parsed }));
  const worker = createOcrWorker({ ...dependencies, enricher, thresholds });
  try {
    await worker.runOnce();
    assert.deepEqual(dependencies.calls.enrichments[0].thresholds, thresholds);
  } finally { await worker.stop(); }
});

test("vision-only recovery cannot silently complete a document beyond its image page cap", async () => {
  const dependencies = workerDependencies({ renderPageCount: 3 });
  dependencies.engine.recognize = async () => ({ text: "", words: [] });
  const worker = createOcrWorker({ ...dependencies, aiMaxPages: 2, enricher: visionEnricher(), clock: () => NOW });
  try {
    await worker.runOnce();
    assert.equal(dependencies.calls.completions.length, 0);
    assert.equal(dependencies.calls.failures[0].failureCode, "OCR_EMPTY_DOCUMENT");
  } finally { await worker.stop(); }
});

test("partial local OCR cannot overrule full-document vision after a later page crashes", async () => {
  const dependencies = workerDependencies({ renderPageCount: 2 });
  let page = 0;
  dependencies.engine.recognize = async () => {
    if (++page === 2) throw Object.assign(new Error("recognition interrupted"), { code: "OCR_RECOGNITION_FAILED" });
    const text = "TOKO MAJU\nTanggal: 25/10/2026\nInvoice No: INV-01\nTotal: IDR 50000";
    return { text, words: text.split(/\s+/).map((text) => ({ text, confidence: 99 })) };
  };
  const worker = createOcrWorker({ ...dependencies, enricher: visionEnricher(), clock: () => NOW });
  try {
    await worker.runOnce();
    const result = dependencies.calls.completions[0].result;
    assert.equal(result.parsed.amount, "150000");
    assert.equal(result.ai.fields.amount.source, "gemini");
    assert.equal(result.ai.fields.amount.tesseractValue, "50000");
    assert.equal(result.ai.fields.amount.tesseractConfidence, 99);
    assert.equal(result.ai.fields.amount.diverged, true);
    assert.equal(result.ai.visionFallback, true);
    assert.ok(result.parsed.extractedText.includes("50000"));
    assert.ok(result.flags.some(({ code }) => code === "AMOUNT_MISMATCH"));
  } finally { await worker.stop(); }
});

test("a structurally valid but empty vision response cannot complete partial local OCR", async () => {
  const dependencies = workerDependencies({ renderPageCount: 2 });
  let page = 0;
  const recognize = dependencies.engine.recognize;
  dependencies.engine.recognize = async (bytes) => {
    if (++page === 2) throw Object.assign(new Error("recognition interrupted"), { code: "OCR_RECOGNITION_FAILED" });
    return recognize(bytes);
  };
  const enricher = createAiEnricher({
    config: readOcrConfig({ GEMINI_ENABLED: "true", GEMINI_API_KEY: "synthetic-test-key", GEMINI_RETRIES: "0" }).gemini,
    async fetchImpl() {
      return { status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        vendor: null, documentDate: null, amount: null, currency: null, invoiceNumber: null,
        fieldConfidence: { vendor: 0, documentDate: 0, amount: 0, currency: 0, invoiceNumber: 0 }, notes: [],
      }) }] } }] }) };
    },
  });
  const worker = createOcrWorker({ ...dependencies, enricher, clock: () => NOW });
  try {
    await worker.runOnce();
    assert.equal(dependencies.calls.completions.length, 0);
    assert.equal(dependencies.calls.failures[0].failureCode, "OCR_RECOGNITION_FAILED");
  } finally { await worker.stop(); }
});
