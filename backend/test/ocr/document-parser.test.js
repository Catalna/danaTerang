import assert from "node:assert/strict";
import test from "node:test";

import { parseOcrDocument } from "../../src/ocr/documentParser.js";
import { screenOcrResult } from "../../src/ocr/screeningRules.js";

const indonesianText = [
  "LAPAK MAKMUR",
  "Tanggal: 25/10/2026",
  "Invoice No: INV-8821",
  "Total: Rp 1.250.000,50",
].join("\n");

const indonesianWords = [
  { text: "LAPAK", confidence: 90 }, { text: "MAKMUR", confidence: 80 },
  { text: "Tanggal:", confidence: 91 }, { text: "25/10/2026", confidence: 88 },
  { text: "Invoice", confidence: 90 }, { text: "No:", confidence: 90 }, { text: "INV-8821", confidence: 82 },
  { text: "Total:", confidence: 90 }, { text: "Rp", confidence: 99 }, { text: "1.250.000,50", confidence: 95 },
];

test("parses Indonesian receipt fields, exact decimal amount, and per-field confidence", () => {
  const parsed = parseOcrDocument({ text: indonesianText, words: indonesianWords });

  assert.equal(parsed.vendor, "LAPAK MAKMUR");
  assert.equal(parsed.documentDate, "2026-10-25");
  assert.equal(parsed.amount, "1250000.5");
  assert.equal(parsed.currency, "IDR");
  assert.equal(parsed.invoiceNumber, "INV-8821");
  assert.equal(parsed.detectedLanguage, "id");
  assert.deepEqual(parsed.fieldConfidence, { vendor: 85, documentDate: 88, amount: 95, invoiceNumber: 82 });
  assert.equal(parsed.extractedText, indonesianText);
});

test("parses English dates, invoice labels, and decimal amounts without floating-point conversion", () => {
  const text = [
    "ACME SUPPLY",
    "Invoice Date: 2026-10-25",
    "Invoice No: INV-2026-001",
    "Amount Due: USD 1,245.50",
  ].join("\n");
  const words = [
    { text: "ACME", confidence: 91 }, { text: "SUPPLY", confidence: 87 },
    { text: "2026-10-25", confidence: 92 }, { text: "INV-2026-001", confidence: 89 },
    { text: "1,245.50", confidence: 98 },
  ];
  const parsed = parseOcrDocument({ text, words });

  assert.equal(parsed.vendor, "ACME SUPPLY");
  assert.equal(parsed.documentDate, "2026-10-25");
  assert.equal(parsed.amount, "1245.5");
  assert.equal(parsed.currency, "USD");
  assert.equal(parsed.invoiceNumber, "INV-2026-001");
  assert.equal(parsed.detectedLanguage, "en");
  assert.equal(parsed.fieldConfidence.amount, 98);
});

test("returns mixed/unknown language and does not guess ambiguous dates or currency", () => {
  const mixed = parseOcrDocument({
    text: "TOTAL INVOICE DATE AMOUNT PURCHASE PAYMENT\nJUMLAH PEMBELIAN BAHAN TANGGAL NOTA",
    words: [],
  });
  assert.equal(mixed.detectedLanguage, "mixed");

  const ambiguous = parseOcrDocument({ text: "03/04/2026\n1,234", words: [] });
  assert.equal(ambiguous.documentDate, null);
  assert.equal(ambiguous.amount, null);
  assert.equal(ambiguous.currency, null);
  assert.equal(ambiguous.detectedLanguage, "unknown");
  assert.deepEqual(ambiguous.fieldConfidence, { vendor: 0, documentDate: 0, amount: 0, invoiceNumber: 0 });
});

test("optional invoice number stays null when absent and Indonesian month names normalize", () => {
  const parsed = parseOcrDocument({
    text: "KOPERASI MAJU\nTanggal: 15 Okt 2026\nJumlah: 50000 IDR",
    words: [],
  });
  assert.equal(parsed.vendor, "KOPERASI MAJU");
  assert.equal(parsed.documentDate, "2026-10-15");
  assert.equal(parsed.amount, "50000");
  assert.equal(parsed.currency, "IDR");
  assert.equal(parsed.invoiceNumber, null);
  assert.equal(parsed.fieldConfidence.invoiceNumber, 0);
});

test("item counts never replace the grand total or hide an over-budget receipt", () => {
  const text = "TOKO MAJU\nTanggal: 25/10/2026\nInvoice No: INV-01\nTotal Items: 2\nGrand Total: IDR 150000\nCash: IDR 200000\nChange: IDR 50000";
  const parsed = parseOcrDocument({ text, words: text.split(/\s+/).map((text) => ({ text, confidence: 99 })) });
  assert.equal(parsed.amount, "150000");
  const screened = screenOcrResult({ parsed, milestone: { budgetAmount: "100000", currency: "IDR" }, today: "2026-11-20" });
  assert.equal(screened.screeningStatus, "FLAGGED");
  assert.ok(screened.flags.some(({ code }) => code === "AMOUNT_MISMATCH"));
});

test("final totals outrank earlier totals and subtotal/tax/payment lines", () => {
  const parsed = parseOcrDocument({ text: "TOKO MAJU\nTotal: IDR 100000\nSub Total: IDR 100000\nPPN: IDR 11000\nTotal Pembayaran: Rp111.000\nTunai: Rp200.000\nKembalian: Rp89.000" });
  assert.equal(parsed.amount, "111000");
  assert.equal(parsed.currency, "IDR");
});

test("a total label can read the amount on the immediately following line", () => {
  const parsed = parseOcrDocument({ text: "TOKO MAJU\nGRAND TOTAL\nRp 150.000,50" });
  assert.equal(parsed.amount, "150000.5");
  assert.equal(parsed.currency, "IDR");
});

test("conflicting totals of equal priority stay unknown", () => {
  assert.equal(parseOcrDocument({ text: "TOKO MAJU\nTotal: IDR 50000\nTotal: IDR 150000" }).amount, null);
});

test("years, quantities, phone numbers, and negative totals are not guessed as amounts", () => {
  for (const text of ["SOP Member\nTahun 2027", "TOKO MAJU\nTotal Items: 2", "TOKO MAJU\nJumlah Barang: 3", "TOKO MAJU\nTotal Belanja 2 Item", "TOKO MAJU\nPhone: 08123456789", "TOKO MAJU\nTotal: IDR -50000"]) {
    assert.equal(parseOcrDocument({ text }).amount, null, text);
  }
});

test("a uniquely recognizable month typo is recovered using the confidence of the month too", () => {
  const parsed = parseOcrDocument({
    text: "TOKO CONTOH\nTANGGAL: 31 OKTUBER 2026\nTotal: IDR 50000",
    words: [{ text: "31", confidence: 92 }, { text: "OKTUBER", confidence: 60 }, { text: "2026", confidence: 91 }],
  });
  assert.equal(parsed.documentDate, "2026-10-31");
  assert.equal(parsed.fieldConfidence.documentDate, 81);
  assert.equal(parseOcrDocument({ text: "Tanggal: 31 FEBRUARl 2026" }).documentDate, null);
  assert.equal(parseOcrDocument({ text: "Tanggal: 31 JUXX 2026" }).documentDate, null);
  assert.equal(parseOcrDocument({ text: "Tanggal: 15 JUUI 2026" }).documentDate, null);
});

test("amount confidence excludes quantities, invoice digits, and unrelated numeric substrings", () => {
  const parsed = parseOcrDocument({
    text: "TOKO MAJU\nTanggal: 25/10/2026\nInvoice No: INV-150\nTotal Items: 1\nGrand Total: IDR 150000",
    words: [
      { text: "TOKO", confidence: 99 }, { text: "MAJU", confidence: 99 },
      { text: "25/10/2026", confidence: 99 }, { text: "INV-150", confidence: 99 },
      { text: "1", confidence: 99 }, { text: "150000", confidence: 70 },
    ],
  });
  assert.equal(parsed.fieldConfidence.amount, 70);
  assert.ok(screenOcrResult({ parsed }).flags.some(({ code, field }) => code === "LOW_CONFIDENCE_FIELD" && field === "amount"));
});

test("a fragmented amount uses the confidence of every numeric fragment", () => {
  const parsed = parseOcrDocument({
    text: "TOKO MAJU\nTotal: IDR 150 000",
    words: [{ text: "150", confidence: 95 }, { text: "000", confidence: 55 }],
  });
  assert.equal(parsed.amount, "150000");
  assert.equal(parsed.fieldConfidence.amount, 75);
  const absent = parseOcrDocument({ text: "TOKO MAJU\nTotal: IDR 150000", words: [{ text: "1", confidence: 99 }] });
  assert.equal(absent.fieldConfidence.amount, 0);
});
