import { franc } from "franc-min";

const MONTHS = new Map([
  ["jan", 1], ["january", 1], ["januari", 1], ["feb", 2], ["february", 2], ["februari", 2],
  ["mar", 3], ["march", 3], ["maret", 3], ["apr", 4], ["april", 4], ["mei", 5], ["may", 5],
  ["jun", 6], ["june", 6], ["juni", 6], ["jul", 7], ["july", 7], ["juli", 7],
  ["aug", 8], ["august", 8], ["agu", 8], ["agustus", 8], ["sep", 9], ["september", 9],
  ["oct", 10], ["october", 10], ["okt", 10], ["oktober", 10], ["nov", 11], ["november", 11],
  ["dec", 12], ["december", 12], ["des", 12], ["desember", 12],
]);
const CURRENCY_CODES = ["IDR", "USD", "EUR", "GBP", "SGD", "AUD", "CAD", "MYR", "JPY"];
const CURRENCY_WORD = new RegExp(`\\b(?:${CURRENCY_CODES.join("|")})\\b|\\b(?:RP(?=\\b|\\d)|RUPIAH\\b)\\.?|[€£]`, "i");
const FINAL_TOTAL_LABEL = /\b(?:grand\s+total|net\s+total|amount\s+due|total\s+(?:bayar|pembayaran|belanja|akhir)|jumlah\s+(?:pembayaran|yang\s+harus\s+dibayar))\b/i;
const MONEY_LABEL = /\b(?:total|amount|jumlah)\b/i;
const NON_TOTAL_LINE = /\b(?:sub\s*total|tax|ppn|pajak|discount|diskon|change|kembalian|cash|tunai|phone|tel|rekening|account)\b/i;
const ITEM_COUNT_LINE = /\b(?:total|jumlah)\s*(?:items?|barang|qty|quantity|units?|produk|pcs)\b|\b(?:items?|barang|qty|quantity|units?|pcs)\s*(?:total|jumlah)\b|\b\d+\s*(?:items?|barang|units?|produk|pcs)\b/i;
const DATE_LABEL = /\b(?:date|tanggal)\b/i;
const INVOICE_LABEL = /\b(?:invoice|faktur|inv\.?|nomor\s+faktur)\b/i;

function normalizedToken(value) {
  return String(value ?? "").toLocaleLowerCase("id-ID").replace(/[^\p{L}\p{N}]/gu, "");
}

function confidenceFor(words, value, mode = "token") {
  if (mode === "digits") {
    // Match complete numeric tokens (or the exact whitespace-separated pieces
    // of an amount), never a quantity or invoice whose digits are a substring.
    const parts = String(value).trim().split(/\s+/).map((part) => part.replace(/\D/g, ""));
    const tokens = (Array.isArray(words) ? words : []).map((word) => {
      if (typeof word?.text !== "string" || !Number.isFinite(word.confidence)) return null;
      const numeric = word.text.trim().replace(/^(?:RP\.?|IDR|USD|EUR|GBP|SGD|AUD|CAD|MYR|JPY|[$€£])\s*/i, "");
      return /^\d[\d.,]*$/.test(numeric) ? { digits: numeric.replace(/\D/g, ""), confidence: Math.max(0, Math.min(100, word.confidence)) } : null;
    });
    let lowest = null;
    for (let index = 0; index <= tokens.length - parts.length; index++) {
      if (parts.every((part, offset) => part && tokens[index + offset]?.digits === part)) {
        const confidence = Math.round(parts.reduce((sum, _part, offset) => sum + tokens[index + offset].confidence, 0) / parts.length);
        lowest = Math.min(lowest ?? 100, confidence);
      }
    }
    return lowest ?? 0;
  }
  const target = normalizedToken(value);
  if (!target) return 0;
  const matched = (Array.isArray(words) ? words : []).filter((word) => {
    if (typeof word?.text !== "string" || !Number.isFinite(word.confidence)) return false;
    const token = normalizedToken(word.text);
    return token && (target.includes(token) || token.includes(target));
  });
  if (matched.length === 0) return 0;
  return Math.round(matched.reduce((sum, word) => sum + Math.max(0, Math.min(100, word.confidence)), 0) / matched.length);
}

function isValidDate(year, month, day) {
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isoDate(year, month, day) {
  if (!isValidDate(year, month, day)) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function oneEditApart(left, right) {
  if (Math.abs(left.length - right.length) > 1) return false;
  let edits = 0;
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) { leftIndex++; rightIndex++; continue; }
    if (++edits > 1) return false;
    if (left.length >= right.length) leftIndex++;
    if (right.length >= left.length) rightIndex++;
  }
  return edits + (left.length - leftIndex) + (right.length - rightIndex) <= 1;
}

function uniquelyReadMonth(word) {
  const normalized = word.toLocaleLowerCase("id-ID");
  const candidates = new Set([...MONTHS].filter(([name]) => name.length >= 4 && oneEditApart(normalized, name)).map(([, month]) => month));
  return candidates.size === 1 ? [...candidates][0] : null;
}

function findDate(text) {
  const monthWords = [...MONTHS.keys()].sort((left, right) => right.length - left.length).join("|");
  const namedDate = new RegExp(`\\b(\\d{1,2})\\s+(${monthWords})\\s+(\\d{4})\\b|\\b(${monthWords})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, "i");
  for (const line of text.split(/\r?\n/)) {
    const iso = line.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
    if (iso) return { value: isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3])), matchedText: iso[0] };
    const numeric = line.match(/\b(\d{1,2})[/. -](\d{1,2})[/. -](\d{4})\b/);
    if (numeric) {
      const first = Number(numeric[1]);
      const second = Number(numeric[2]);
      if (first > 12) return { value: isoDate(Number(numeric[3]), second, first), matchedText: numeric[0] };
      if (second > 12) return { value: isoDate(Number(numeric[3]), first, second), matchedText: numeric[0] };
      return { value: null, matchedText: numeric[0] };
    }
    const named = line.match(namedDate);
    if (named) {
      const day = Number(named[1] ?? named[5]);
      const month = MONTHS.get((named[2] ?? named[4]).toLowerCase());
      const year = Number(named[3] ?? named[6]);
      return { value: isoDate(year, month, day), matchedText: named[0] };
    }
    // Accept a single OCR typo only when it identifies a unique calendar month.
    const approximate = line.match(/\b(\d{1,2})\s+(\p{L}{4,12})\s+(\d{4})\b|\b(\p{L}{4,12})\s+(\d{1,2}),?\s+(\d{4})\b/u);
    if (approximate) {
      const month = uniquelyReadMonth(approximate[2] ?? approximate[4]);
      if (month) return { value: isoDate(Number(approximate[3] ?? approximate[6]), month, Number(approximate[1] ?? approximate[5])), matchedText: approximate[0] };
    }
  }
  return { value: null, matchedText: "" };
}

function languageCode(value) {
  if (value === "ind") return "id";
  if (value === "eng") return "en";
  return "unknown";
}

function detectLanguage(text) {
  const informativeLines = text.split(/\r?\n/)
    .map((line) => line.replace(/\b(?:invoice|receipt|total|date|amount|number|no|tax|subtotal|faktur|nota|struk|jumlah|tanggal|rp|idr|usd)\b/gi, " ").trim())
    .filter((line) => line.length >= 10 && (line.match(/\p{L}{3,}/gu) ?? []).length >= 2);
  const lineLanguages = new Set(informativeLines.map((line) => franc(line, { only: ["eng", "ind"], minLength: 10 })).filter((code) => code === "eng" || code === "ind"));
  if (lineLanguages.size > 1) return "mixed";
  return languageCode(franc(text, { only: ["eng", "ind"], minLength: 20 }));
}

function canonicalAmount(raw) {
  let token = raw.replace(/[\s ]/g, "");
  if (!/^\d[\d.,]*$/.test(token) || token.length > 32) return null;
  const separators = [...token.matchAll(/[.,]/g)].map((match) => ({ value: match[0], index: match.index }));
  if (separators.length === 0) return token.replace(/^0+(?=\d)/, "");

  const last = separators.at(-1);
  const fractionalDigits = token.length - last.index - 1;
  let decimalSeparator = null;
  let groupingSeparators = new Set();
  if (new Set(separators.map(({ value }) => value)).size > 1) {
    if (fractionalDigits >= 1 && fractionalDigits <= 2) {
      decimalSeparator = last.value;
      groupingSeparators = new Set(separators.filter(({ index }) => index < last.index).map(({ value }) => value));
    } else if (fractionalDigits === 3) {
      groupingSeparators = new Set(separators.map(({ value }) => value));
    } else return null;
  } else if (separators.length > 1) {
    if (fractionalDigits >= 1 && fractionalDigits <= 2) decimalSeparator = last.value;
    else if (fractionalDigits === 3) groupingSeparators.add(last.value);
    else return null;
  } else if (fractionalDigits <= 2) decimalSeparator = last.value;
  else if (fractionalDigits === 3) groupingSeparators.add(last.value);
  else return null;

  const parts = decimalSeparator ? token.split(decimalSeparator) : [token];
  if (parts.length > 2) return null;
  let integerPart = parts[0];
  for (const separator of groupingSeparators) {
    const groups = integerPart.split(separator);
    if (groups[0].length < 1 || groups[0].length > 3 || groups.slice(1).some((group) => group.length !== 3)) return null;
    integerPart = groups.join("");
  }
  if (!/^\d+$/.test(integerPart)) return null;
  const normalizedInteger = integerPart.replace(/^0+(?=\d)/, "");
  const fraction = (parts[1] ?? "").replace(/\D/g, "").replace(/0+$/, "");
  return fraction ? `${normalizedInteger}.${fraction}` : normalizedInteger;
}

function currencyFromLine(line) {
  const found = new Set();
  for (const code of CURRENCY_CODES) if (new RegExp(`\\b${code}\\b`, "i").test(line)) found.add(code);
  if (/\b(?:RP(?=\b|\d)|RUPIAH\b)\.?/i.test(line)) found.add("IDR");
  if (/€/u.test(line)) found.add("EUR");
  if (/£/u.test(line)) found.add("GBP");
  return found.size === 1 ? [...found][0] : null;
}

const NUMBER_PATTERN = /(?:\d{1,3}(?:[., ]\d{3})+|\d+)(?:[.,]\d{1,2})?/g;

function findAmount(lines) {
  const empty = { value: null, matchedText: "", currency: null };
  const candidates = [];
  for (const [index, line] of lines.entries()) {
    if (NON_TOTAL_LINE.test(line) || ITEM_COUNT_LINE.test(line) || DATE_LABEL.test(line)
        || INVOICE_LABEL.test(line) || findDate(line).matchedText) continue;
    const finalLabel = line.match(FINAL_TOTAL_LABEL);
    const label = finalLabel ?? line.match(MONEY_LABEL);
    const rank = finalLabel ? 3 : label ? 2 : CURRENCY_WORD.test(line) ? 1 : 0;
    if (!rank || (!label && /\b(?:qty|quantity|units?|pcs|harga|price)\b/i.test(line))) continue;
    let valueText = label ? line.slice(label.index + label[0].length).trim() : line;
    // Receipts often put the amount immediately below its label.
    if (label && !/\d/.test(valueText) && /^[\d\s.,€£:$A-Z-]+$/i.test(lines[index + 1] ?? "")) {
      valueText += ` ${lines[index + 1]}`;
    }
    const matches = [...valueText.matchAll(NUMBER_PATTERN)].filter((match) => {
      const before = valueText[match.index - 1] ?? "";
      const after = valueText.slice(match.index + match[0].length);
      return !/[\d.,-]/.test(before) && !/^[\d.,]/.test(after) && !/^\s*%/.test(after);
    });
    // Multiple amounts on one line are ambiguous; never substitute a quantity/year.
    if (matches.length !== 1) continue;
    const value = canonicalAmount(matches[0][0]);
    if (value !== null) candidates.push({ value, matchedText: matches[0][0], currency: currencyFromLine(`${line} ${valueText}`), rank });
  }
  if (!candidates.length) return empty;
  const highestRank = candidates.reduce((highest, { rank }) => Math.max(highest, rank), 0);
  const strongest = candidates.filter(({ rank }) => rank === highestRank);
  if (new Set(strongest.map(({ value }) => value)).size !== 1) return empty;
  return strongest[0];
}

function findVendor(lines) {
  const heading = /^(?:tax\s+)?(?:invoice|receipt|faktur|nota|struk|date|tanggal|time|waktu|total|jumlah|amount|grand\s+total|subtotal)\b/i;
  return lines.find((line) => /\p{L}/u.test(line) && !heading.test(line)) ?? null;
}

function findInvoiceNumber(text) {
  const patterns = [
    /\b(?:invoice|faktur)\s*(?:no\.?|number|nomor|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/._-]{1,39})/i,
    /\b(?:inv\.?|nomor\s+faktur)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/._-]{1,39})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return { value: match[1].replace(/[.,;:]$/, ""), matchedText: match[1] };
  }
  return { value: null, matchedText: "" };
}

export function parseOcrDocument({ text, words = [] } = {}) {
  const extractedText = typeof text === "string" ? text : "";
  const lines = extractedText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const vendor = findVendor(lines);
  const date = findDate(extractedText);
  const amount = findAmount(lines);
  const invoice = findInvoiceNumber(extractedText);
  const currency = amount.currency ?? currencyFromLine(extractedText);

  return {
    vendor,
    documentDate: date.value,
    amount: amount.value,
    currency,
    invoiceNumber: invoice.value,
    detectedLanguage: detectLanguage(extractedText),
    fieldConfidence: {
      vendor: vendor ? confidenceFor(words, vendor) : 0,
      documentDate: date.value ? confidenceFor(words, date.matchedText) : 0,
      amount: amount.value ? confidenceFor(words, amount.matchedText, "digits") : 0,
      invoiceNumber: invoice.value ? confidenceFor(words, invoice.matchedText) : 0,
    },
    extractedText,
  };
}
