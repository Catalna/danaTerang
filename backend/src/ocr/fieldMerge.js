import { DEFAULT_THRESHOLDS } from "./screeningRules.js";

export const OCR_FIELD_KEYS = Object.freeze(["vendor", "documentDate", "amount", "currency", "invoiceNumber"]);
const CONFIDENCE_FIELDS = ["vendor", "documentDate", "amount", "invoiceNumber"];
const CURRENCY_CODES = new Set(["IDR", "USD", "EUR", "GBP", "SGD", "AUD", "CAD", "MYR", "JPY"]);

function normalizeVendor(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 240 ? trimmed : null;
}

function normalizeDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function normalizeAmount(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 32 || !/^\d+(?:\.\d{1,6})?$/.test(value)) return null;
  const [integer, fraction = ""] = value.split(".");
  if (integer.length > 20) return null;
  const normalizedInteger = integer.replace(/^0+(?=\d)/, "");
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? `${normalizedInteger}.${normalizedFraction}` : normalizedInteger;
}

function normalizeCurrency(value) {
  if (typeof value !== "string") return null;
  const code = value.trim().toLocaleUpperCase("en-US");
  return CURRENCY_CODES.has(code) ? code : null;
}

function normalizeInvoice(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[A-Z0-9][A-Z0-9/._ -]{0,79}$/i.test(trimmed) ? trimmed : null;
}

const NORMALIZERS = {
  vendor: normalizeVendor, documentDate: normalizeDate, amount: normalizeAmount,
  currency: normalizeCurrency, invoiceNumber: normalizeInvoice,
};

function confidence(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100 ? value : 0;
}

function equivalent(field, left, right) {
  if (["amount", "documentDate", "currency"].includes(field)) return left === right;
  return left.toLocaleLowerCase("id-ID") === right.toLocaleLowerCase("id-ID");
}

/** Pure merge policy. Transport and review/blockchain never run here. */
export function mergeOcrFields({ parsed, candidate, fieldThreshold = 80, thresholds = DEFAULT_THRESHOLDS, localOcrComplete = true }) {
  const source = parsed ?? {};
  const decisions = {};
  const local = {};
  const ai = {};
  for (const field of OCR_FIELD_KEYS) {
    // Keep partial local readings in provenance, but do not treat them as a
    // complete document when vision is recovering a recognition failure.
    const originalValue = NORMALIZERS[field](source[field]);
    local[field] = localOcrComplete ? originalValue : null;
    ai[field] = NORMALIZERS[field](candidate[field]);
    const localValue = local[field];
    const aiValue = ai[field];
    const localConfidence = localValue === null ? 0 : confidence(source.fieldConfidence?.[field]);
    const aiConfidence = aiValue === null ? 0 : confidence(candidate.fieldConfidence?.[field]);
    const diverged = originalValue !== null && aiValue !== null && !equivalent(field, originalValue, aiValue);
    let useAi = false;
    if (aiValue !== null) {
      if (localValue === null) useAi = field !== "currency" || aiConfidence >= fieldThreshold;
      else if (diverged) useAi = aiConfidence >= fieldThreshold
        && localConfidence < (thresholds?.[field] ?? DEFAULT_THRESHOLDS[field] ?? fieldThreshold);
    }
    decisions[field] = {
      value: useAi ? aiValue : localValue,
      confidence: useAi ? aiConfidence : localConfidence,
      source: useAi ? "gemini" : localValue !== null ? "tesseract" : "none",
      diverged,
    };
  }

  // Never combine, for example, a retained USD 50,000 local reading with the
  // IDR currency from an AI reading of 85,000. Accept or retain that pair together.
  if (ai.currency !== null && ai.currency !== local.currency && ai.amount !== local.amount
      && (decisions.amount.source !== "gemini" || decisions.currency.source !== "gemini")) {
    for (const field of ["amount", "currency"]) {
      decisions[field] = {
        value: local[field], confidence: local[field] === null ? 0 : confidence(source.fieldConfidence?.[field]),
        source: local[field] === null ? "none" : "tesseract",
        diverged: decisions[field].diverged || ai[field] !== local[field],
      };
    }
  }

  const merged = {
    detectedLanguage: source.detectedLanguage ?? "unknown",
    fieldConfidence: {},
    extractedText: typeof source.extractedText === "string" ? source.extractedText : undefined,
  };
  const fields = {};
  for (const field of OCR_FIELD_KEYS) {
    const decision = decisions[field];
    merged[field] = decision.value;
    if (CONFIDENCE_FIELDS.includes(field)) merged.fieldConfidence[field] = decision.confidence;
    fields[field] = {
      source: decision.source, diverged: decision.diverged,
      geminiValue: candidate[field] ?? null, tesseractValue: NORMALIZERS[field](source[field]),
      tesseractConfidence: source.fieldConfidence?.[field] ?? null,
      aiConfidence: confidence(candidate.fieldConfidence?.[field]),
    };
  }
  return { merged, fields };
}
