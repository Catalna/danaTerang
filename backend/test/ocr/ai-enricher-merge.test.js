import assert from "node:assert/strict";
import test from "node:test";

import { createAiEnricher } from "../../src/ocr/aiEnricher.js";

const BASE_PARSED = {
  vendor: "TOKO MAJU",
  documentDate: "2026-10-25",
  amount: "50000",
  currency: "IDR",
  invoiceNumber: "INV-2026-01",
  detectedLanguage: "id",
  fieldConfidence: { vendor: 95, documentDate: 96, amount: 97, invoiceNumber: 95 },
};

function geminiConfig(overrides = {}) {
  return {
    enabled: true,
    apiKey: "test-key",
    model: "gemini-2.5-flash",
    timeoutMs: 5000,
    maxPages: 4,
    retries: 1,
    fieldThreshold: 80,
    maxOutputTokens: 2048,
    cooldownMs: 60000,
    ...overrides,
  };
}

function parsedFixture(overrides = {}) {
  return { ...BASE_PARSED, ...overrides };
}

function geminiPayload(fields = {}, confidenceOverrides = {}) {
  return {
    vendor: "TOKO MAJU SEJATI",
    documentDate: "2026-10-25",
    amount: "85000",
    currency: "IDR",
    invoiceNumber: "INV-2026-01",
    fieldConfidence: { vendor: 92, documentDate: 90, amount: 95, currency: 95, invoiceNumber: 88, ...confidenceOverrides },
    notes: [],
    ...fields,
  };
}

function envelopeOf(fields) {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(fields) }] } }] };
}

function fakeFetch(responseForAttempt = () => ({ body: envelopeOf(geminiPayload()) })) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const outcome = responseForAttempt(calls.length, init, url) ?? { status: 200, body: "" };
    return {
      status: outcome.status ?? 200,
      text: async () => (typeof outcome.body === "string" ? outcome.body : JSON.stringify(outcome.body)),
    };
  };
  return { calls, fetchImpl };
}

function baseDeps(overrides = {}) {
  const { calls, fetchImpl } = fakeFetch();
  return { calls, fetchImpl, clock: () => new Date("2026-10-26T12:00:00.000Z"), sleep: async () => {}, ...overrides };
}

async function enrich(deps, { parsed = parsedFixture(), text = "TOKO MAJU\nTotal: Rp 85.000", pages = [Buffer.from("page-1")] } = {}) {
  const enricher = createAiEnricher({
    config: geminiConfig(deps.configOverrides ?? {}),
    fetchImpl: deps.fetchImpl,
    clock: deps.clock,
    sleep: deps.sleep,
  });
  return enricher.enrich({ parsed, text, pages });
}

test("enrich skips the API entirely and reports DISABLED when the feature is off", async () => {
  const deps = baseDeps({ configOverrides: { enabled: false, apiKey: null } });
  const outcome = await enrich(deps);
  assert.equal(outcome.ai.status, "DISABLED");
  assert.equal(outcome.ai.reason, "GEMINI_DISABLED");
  assert.equal(outcome.ai.model, null);
  assert.equal(outcome.ai.promptHash, null);
  assert.deepEqual(outcome.merged, parsedFixture());
  assert.equal(deps.calls.length, 0);
});

test("enrich adopts a Gemini value only for a field Tesseract failed to read", async () => {
  const deps = baseDeps();
  const outcome = await enrich(deps, {
    parsed: parsedFixture({ vendor: null, fieldConfidence: { vendor: 0, documentDate: 96, amount: 97, invoiceNumber: 95 } }),
  });
  assert.equal(outcome.ai.status, "APPLIED");
  assert.equal(outcome.merged.vendor, "TOKO MAJU SEJATI");
  assert.equal(outcome.merged.fieldConfidence.vendor, 92);
  assert.equal(outcome.ai.fields.vendor.source, "gemini");
  assert.deepEqual(Object.keys(outcome.merged.fieldConfidence).sort(), ["amount", "documentDate", "invoiceNumber", "vendor"]);
});

test("enrich keeps the Tesseract value when both readings agree", async () => {
  const deps = baseDeps({
    fetchImpl: fakeFetch(() => ({ body: envelopeOf(geminiPayload({ vendor: "toko maju" })) })).fetchImpl,
  });
  const outcome = await enrich(deps);
  assert.equal(outcome.merged.vendor, "TOKO MAJU");
  assert.equal(outcome.merged.fieldConfidence.vendor, 95);
  assert.equal(outcome.ai.fields.vendor.source, "tesseract");
  assert.equal(outcome.ai.fields.vendor.diverged, false);
});

test("enrich adopts a high-confidence Gemini correction when the Tesseract reading was weak", async () => {
  const deps = baseDeps();
  const outcome = await enrich(deps, {
    parsed: parsedFixture({ amount: "50000", fieldConfidence: { vendor: 95, documentDate: 96, amount: 20, invoiceNumber: 95 } }),
  });
  assert.equal(outcome.merged.amount, "85000");
  assert.equal(outcome.merged.fieldConfidence.amount, 95);
  assert.equal(outcome.ai.fields.amount.source, "gemini");
  assert.equal(outcome.ai.fields.amount.diverged, true);
  assert.equal(outcome.ai.fields.amount.geminiValue, "85000");
});

test("enrich keeps the Tesseract value and records divergence when both readings were confident", async () => {
  const deps = baseDeps();
  const outcome = await enrich(deps);
  assert.equal(outcome.merged.amount, "50000");
  assert.equal(outcome.merged.fieldConfidence.amount, 97);
  assert.equal(outcome.ai.fields.amount.source, "tesseract");
  assert.equal(outcome.ai.fields.amount.diverged, true);
  assert.equal(outcome.ai.fields.amount.geminiValue, "85000");
});

test("enrich treats malformed Gemini values the same as missing", async () => {
  const deps = baseDeps({
    fetchImpl: fakeFetch(() => ({
      body: envelopeOf(geminiPayload({
        vendor: "   ",
        documentDate: "10/25/2026",
        amount: "Rp 85.000",
        currency: "rupiah",
        invoiceNumber: "",
      })),
    })).fetchImpl,
  });
  const outcome = await enrich(deps, {
    parsed: parsedFixture({
      vendor: null,
      documentDate: null,
      amount: null,
      currency: "IDR",
      invoiceNumber: null,
      fieldConfidence: { vendor: 0, documentDate: 0, amount: 0, invoiceNumber: 0 },
    }),
  });
  assert.equal(outcome.ai.status, "APPLIED");
  assert.equal(outcome.merged.vendor, null);
  assert.equal(outcome.merged.documentDate, null);
  assert.equal(outcome.merged.amount, null);
  assert.equal(outcome.merged.invoiceNumber, null);
  assert.equal(outcome.merged.currency, "IDR");
  assert.equal(outcome.ai.fields.vendor.source, "none");
  assert.equal(outcome.ai.fields.currency.source, "tesseract");
});

test("enrich normalizes a lower-case currency code from Gemini", async () => {
  const deps = baseDeps({
    fetchImpl: fakeFetch(() => ({ body: envelopeOf(geminiPayload({ amount: "50000", currency: "idr" })) })).fetchImpl,
  });
  const outcome = await enrich(deps, {
    parsed: parsedFixture({ currency: null, fieldConfidence: { vendor: 95, documentDate: 96, amount: 97, invoiceNumber: 0 } }),
  });
  assert.equal(outcome.merged.currency, "IDR");
  assert.equal(outcome.ai.fields.currency.source, "gemini");
});

test("enrich rejects an impossible calendar date from Gemini", async () => {
  const deps = baseDeps({
    fetchImpl: fakeFetch(() => ({ body: envelopeOf(geminiPayload({ documentDate: "2026-02-30" })) })).fetchImpl,
  });
  const outcome = await enrich(deps, {
    parsed: parsedFixture({ documentDate: null, fieldConfidence: { vendor: 95, documentDate: 0, amount: 97, invoiceNumber: 95 } }),
  });
  assert.equal(outcome.merged.documentDate, null);
  assert.equal(outcome.ai.fields.documentDate.source, "none");
});

const EXPECTED_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

test("enrich builds the request from the pinned model, key, images, and OCR text", async () => {
  const deps = baseDeps();
  await enrich(deps, { pages: [Buffer.from("page-1"), Buffer.from("page-2")] });
  assert.equal(deps.calls.length, 1);
  const { url, init } = deps.calls[0];
  assert.equal(url, EXPECTED_URL);
  assert.equal(init.method, "POST");
  assert.equal(init.headers["x-goog-api-key"], "test-key");
  const body = JSON.parse(init.body);
  assert.equal(body.generationConfig.temperature, 0);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.generationConfig.maxOutputTokens, 2048);
  assert.deepEqual(body.generationConfig.responseSchema.properties.fieldConfidence.required, ["vendor", "documentDate", "amount", "currency", "invoiceNumber"]);
  const imageParts = body.contents[0].parts.filter((part) => part.inline_data);
  assert.deepEqual(imageParts, [
    { inline_data: { mime_type: "image/png", data: Buffer.from("page-1").toString("base64") } },
    { inline_data: { mime_type: "image/png", data: Buffer.from("page-2").toString("base64") } },
  ]);
  const textPart = body.contents[0].parts[body.contents[0].parts.length - 1].text;
  assert.ok(textPart.includes("TOKO MAJU"));
  assert.ok(textPart.includes('"vendor"'));
});

test("enrich caps the OCR text that is sent to Gemini", async () => {
  const deps = baseDeps();
  await enrich(deps, { text: "X".repeat(45000) });
  const body = JSON.parse(deps.calls[0].init.body);
  const textPart = body.contents[0].parts[body.contents[0].parts.length - 1].text;
  assert.equal((textPart.match(/X/g) ?? []).length, 40000);
});

test("enrich caps the number of pages sent to Gemini", async () => {
  const deps = baseDeps({ configOverrides: { maxPages: 2 } });
  const outcome = await enrich(deps, { pages: [Buffer.from("p1"), Buffer.from("p2"), Buffer.from("p3"), Buffer.from("p4")] });
  assert.equal(outcome.ai.pagesSent, 2);
  const body = JSON.parse(deps.calls[0].init.body);
  assert.equal(body.contents[0].parts.filter((part) => part.inline_data).length, 2);
});

test("enrich records provenance for audit while applying the merge", async () => {
  const deps = baseDeps();
  const outcome = await enrich(deps);
  assert.equal(outcome.ai.status, "APPLIED");
  assert.equal(outcome.ai.model, "gemini-2.5-flash");
  assert.match(outcome.ai.promptHash, /^[0-9a-f]{64}$/);
  assert.ok(Number.isFinite(outcome.ai.durationMs));
  assert.equal(outcome.ai.attempts, 1);
  assert.ok(outcome.ai.responseSnippet.includes("TOKO MAJU SEJATI"));
  assert.deepEqual(Object.keys(outcome.ai.fields).sort(), ["amount", "currency", "documentDate", "invoiceNumber", "vendor"]);
});

test("enrich without pages still sends the OCR text", async () => {
  const deps = baseDeps();
  const outcome = await enrich(deps, { pages: [] });
  assert.equal(outcome.ai.status, "APPLIED");
  assert.equal(outcome.ai.pagesSent, 0);
  const body = JSON.parse(deps.calls[0].init.body);
  assert.equal(body.contents[0].parts.filter((part) => part.inline_data).length, 0);
  assert.equal(body.contents[0].parts.some((part) => typeof part.text === "string" && part.text.includes("TOKO MAJU")), true);
});

test("enrich truncates the stored response snippet", async () => {
  const deps = baseDeps({
    fetchImpl: fakeFetch(() => ({ body: envelopeOf(geminiPayload({ notes: ["n".repeat(20000)] })) })).fetchImpl,
  });
  const outcome = await enrich(deps);
  assert.ok(outcome.ai.responseSnippet.length <= 16000);
});

test("merge uses the amount screening threshold instead of the Gemini acceptance threshold", async () => {
  const outcome = await enrich(baseDeps(), {
    parsed: parsedFixture({ fieldConfidence: { ...BASE_PARSED.fieldConfidence, amount: 85 } }),
  });
  assert.equal(outcome.merged.amount, "85000");
  assert.equal(outcome.ai.fields.amount.tesseractValue, "50000");
});

test("merge preserves a vendor already above its own screening threshold", async () => {
  const outcome = await enrich(baseDeps(), {
    parsed: parsedFixture({ fieldConfidence: { ...BASE_PARSED.fieldConfidence, vendor: 75 } }),
  });
  assert.equal(outcome.merged.vendor, "TOKO MAJU");
  assert.equal(outcome.ai.fields.vendor.diverged, true);
});

test("merge honors explicitly configured per-field thresholds", async () => {
  const deps = baseDeps();
  const enricher = createAiEnricher({ config: geminiConfig(), ...deps });
  const parsed = parsedFixture({ fieldConfidence: { ...BASE_PARSED.fieldConfidence, amount: 85 } });
  const outcome = await enricher.enrich({ parsed, text: "synthetic", pages: [], thresholds: { amount: 84 } });
  assert.equal(outcome.merged.amount, "50000");
});

test("currency can be corrected when both readers agree on the numeric amount", async () => {
  const deps = baseDeps({ fetchImpl: fakeFetch(() => ({ body: envelopeOf(geminiPayload({ amount: "50000" })) })).fetchImpl });
  const outcome = await enrich(deps, { parsed: parsedFixture({ currency: "USD" }) });
  assert.equal(outcome.merged.currency, "IDR");
  assert.equal(outcome.ai.fields.currency.source, "gemini");
  assert.equal(outcome.ai.fields.currency.aiConfidence, 95);
});

test("a low-confidence AI currency remains unknown instead of silently clearing screening", async () => {
  const deps = baseDeps({ fetchImpl: fakeFetch(() => ({ body: envelopeOf(geminiPayload({}, { currency: 10 })) })).fetchImpl });
  const outcome = await enrich(deps, { parsed: parsedFixture({ currency: null }) });
  assert.equal(outcome.merged.currency, null);
});

test("equivalent decimal representations do not create a false divergence", async () => {
  const deps = baseDeps({ fetchImpl: fakeFetch(() => ({ body: envelopeOf(geminiPayload({ amount: "050000.00" })) })).fetchImpl });
  const outcome = await enrich(deps);
  assert.equal(outcome.merged.amount, "50000");
  assert.equal(outcome.ai.fields.amount.diverged, false);
});

test("JPEG buffers retain their correct MIME type in the Gemini request", async () => {
  const deps = baseDeps();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  await enrich(deps, { pages: [jpeg] });
  const image = JSON.parse(deps.calls[0].init.body).contents[0].parts[0].inline_data;
  assert.equal(image.mime_type, "image/jpeg");
  assert.deepEqual(Buffer.from(image.data, "base64"), jpeg);
});

test("prompt hashes identify the images as well as the text", async () => {
  const first = await enrich(baseDeps(), { pages: [Buffer.from("first-image")] });
  const second = await enrich(baseDeps(), { pages: [Buffer.from("second-image")] });
  assert.notEqual(first.ai.promptHash, second.ai.promptHash);
});

test("oversized image requests fail open before any network call", async () => {
  const deps = baseDeps();
  const outcome = await enrich(deps, { pages: [Buffer.alloc(14 * 1024 * 1024)] });
  assert.equal(outcome.ai.reason, "REQUEST_TOO_LARGE");
  assert.equal(outcome.ai.attempts, 0);
  assert.equal(outcome.ai.pagesSent, 0);
  assert.equal(deps.calls.length, 0);
  assert.deepEqual(outcome.merged, parsedFixture());
});

test("a retained local amount cannot be relabeled with the currency of a different AI amount", async () => {
  const outcome = await enrich(baseDeps(), { parsed: parsedFixture({ currency: "USD" }) });
  assert.equal(outcome.merged.amount, "50000");
  assert.equal(outcome.merged.currency, "USD");
  assert.equal(outcome.ai.fields.currency.source, "tesseract");
  assert.equal(outcome.ai.fields.currency.diverged, true);
  assert.equal(outcome.ai.fields.currency.geminiValue, "IDR");
});

test("unknown currency stays unknown when the AI currency belongs to a rejected amount", async () => {
  const outcome = await enrich(baseDeps(), { parsed: parsedFixture({ currency: null }) });
  assert.equal(outcome.merged.amount, "50000");
  assert.equal(outcome.merged.currency, null);
  assert.equal(outcome.ai.fields.currency.source, "none");
});

test("a cross-currency AI correction requires acceptance of the whole money pair", async () => {
  const parsed = parsedFixture({ currency: "USD", fieldConfidence: { ...BASE_PARSED.fieldConfidence, amount: 20 } });
  const accepted = await enrich(baseDeps(), { parsed });
  assert.equal(accepted.merged.amount, "85000");
  assert.equal(accepted.merged.currency, "IDR");
  const deps = baseDeps({ fetchImpl: fakeFetch(() => ({ body: envelopeOf(geminiPayload({}, { currency: 10 })) })).fetchImpl });
  const rejected = await enrich(deps, { parsed });
  assert.equal(rejected.merged.amount, "50000");
  assert.equal(rejected.merged.currency, "USD");
  assert.equal(rejected.merged.fieldConfidence.amount, 20);
  assert.equal(rejected.ai.fields.amount.source, "tesseract");
});
