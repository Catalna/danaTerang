import "dotenv/config";

import { readOcrConfig } from "../src/ocr/config.js";
import { createDocumentRasterizer } from "../src/ocr/documentRasterizer.js";
import { createTesseractEngine } from "../src/ocr/tesseractEngine.js";
import { parseOcrDocument } from "../src/ocr/documentParser.js";
import { createAiEnricher } from "../src/ocr/aiEnricher.js";
import { createOcrSmokeReport, createSyntheticReceiptPng, createSyntheticReceiptJpeg, createSyntheticReceiptPdf, isOcrSmokeReportAcceptable, SYNTHETIC_RECEIPT_FIELDS } from "../src/ocr/smokeFixture.js";

async function main() {
  const config = readOcrConfig();
  const testAi = process.argv.includes("--ai");
  if (testAi && !config.gemini.enabled) {
    process.stderr.write("AI OCR smoke failed: GEMINI_DISABLED. Set GEMINI_ENABLED=true and GEMINI_API_KEY in backend/.env.\n");
    process.exitCode = 1;
    return;
  }
  const engine = createTesseractEngine({ languageDataPath: config.languageDataPath });
  const renderer = createDocumentRasterizer();
  const enricher = testAi ? createAiEnricher({ config: config.gemini }) : null;
  try {
    let localFailure = null;
    try { await engine.initialize(); }
    catch (error) {
      if (!testAi) throw error;
      localFailure = error;
    }
    const formats = process.argv.includes("--all-formats") ? ["png", "jpeg", "pdf"] : ["png"];
    const fixtures = {
      png: { create: createSyntheticReceiptPng, contentType: "image/png" },
      jpeg: { create: createSyntheticReceiptJpeg, contentType: "image/jpeg" },
      pdf: { create: createSyntheticReceiptPdf, contentType: "application/pdf" },
    };
    for (const format of formats) {
      const pageTexts = [];
      const words = [];
      const aiPages = [];
      for await (const page of renderer.renderEvidencePages({
        bytes: fixtures[format].create(),
        contentType: fixtures[format].contentType,
        maxPages: config.maxPdfPages,
        maxPixels: config.maxImagePixels,
        dpi: config.renderDpi,
      })) {
        if (aiPages.length < config.gemini.maxPages) aiPages.push(page.bytes);
        if (localFailure) continue;
        let result;
        try { result = await engine.recognize(page.bytes); }
        catch (error) {
          if (!testAi) throw error;
          localFailure = error;
          continue;
        }
        if (result.text) pageTexts.push(result.text);
        words.push(...result.words);
      }
      const text = pageTexts.join("\n");
      let parsed = parseOcrDocument({ text, words });
      if (enricher) {
        const enriched = await enricher.enrich({ parsed, text, pages: aiPages, thresholds: config.thresholds });
        const ai = enriched.ai;
        const aiFields = Object.fromEntries(Object.entries(ai.fields ?? {}).map(([field, value]) => [field, value.geminiValue]));
        const aiReport = createOcrSmokeReport({
          ...aiFields, fieldConfidence: Object.fromEntries(Object.entries(ai.fields ?? {}).map(([field, value]) => [field, value.aiConfidence])),
        }, { expectedFields: SYNTHETIC_RECEIPT_FIELDS });
        process.stdout.write(`${JSON.stringify({ format, ai: { status: ai.status, reason: ai.reason, model: ai.model, pagesSent: ai.pagesSent, attempts: ai.attempts, durationMs: ai.durationMs, expectedFieldsMatch: aiReport.expectedFieldsMatch } }, null, 2)}\n`);
        if (ai.status !== "APPLIED" || !isOcrSmokeReportAcceptable(aiReport, config.thresholds)) {
          process.stderr.write("AI OCR smoke failed: the API must return APPLIED and correctly read all synthetic fields at the configured confidence thresholds.\n");
          process.exitCode = 1;
          return;
        }
        parsed = enriched.merged;
      }
      const report = createOcrSmokeReport(parsed, { expectedFields: SYNTHETIC_RECEIPT_FIELDS });
      process.stdout.write(`${JSON.stringify({ format, ...report }, null, 2)}\n`);
      if (!isOcrSmokeReportAcceptable(report, config.thresholds)) {
        process.stderr.write("OCR smoke failed: extracted values or confidence did not match the expected synthetic receipt.\n");
        process.exitCode = 1;
      }
    }
  } catch (error) {
    const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "OCR_SMOKE_FAILED";
    process.stderr.write(`Local OCR smoke failed: ${code}. Check OCR_LANGUAGE_DATA_PATH and the local ind/eng traineddata files.\n`);
    process.exitCode = 1;
  } finally {
    await engine.close();
  }
}

main().catch(() => {
  process.stderr.write("Local OCR smoke failed: OCR_SMOKE_FAILED. Check local OCR setup.\n");
  process.exitCode = 1;
});
