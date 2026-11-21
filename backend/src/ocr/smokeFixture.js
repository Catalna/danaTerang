import { createCanvas } from "@napi-rs/canvas";

export const SYNTHETIC_RECEIPT_FIELDS = Object.freeze({
  vendor: "TOKO CONTOH", documentDate: "2026-10-31", amount: "50000", currency: "IDR", invoiceNumber: "DEMO-2026-01",
});

function createReceiptCanvas() {
  const width = 1600;
  const height = 1150;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#111827";
  context.font = "bold 72px sans-serif";
  context.fillText("TOKO CONTOH", 100, 160);
  context.font = "58px sans-serif";
  context.fillText("TANGGAL: 31 OKTOBER 2026", 100, 360);
  context.font = "54px sans-serif";
  context.fillText("Invoice No: DEMO-2026-01", 100, 560);
  context.font = "bold 90px sans-serif";
  context.fillText("TOTAL PEMBAYARAN: IDR 50000", 100, 820);
  return canvas;
}

export function createSyntheticReceiptPng() {
  return createReceiptCanvas().toBuffer("image/png");
}

export function createSyntheticReceiptJpeg() {
  return createReceiptCanvas().toBuffer("image/jpeg");
}

export function createSyntheticReceiptPdf() {
  const jpeg = createSyntheticReceiptJpeg();
  const content = Buffer.from("q\n800 0 0 575 0 0 cm\n/Receipt Do\nQ\n");
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 575] /Resources << /XObject << /Receipt 4 0 R >> >> /Contents 5 0 R >>"),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1600 /Height 1150 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from("\nendstream")]),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("endstream")]),
  ];
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets = [];
  let length = parts[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const bytes = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    parts.push(bytes);
    length += bytes.length;
  }
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`));
  return Buffer.concat(parts);
}

export function createOcrSmokeReport(parsed, { expectedFields } = {}) {
  const fields = {};
  for (const field of ["vendor", "documentDate", "amount", "invoiceNumber"]) {
    const value = parsed?.[field];
    const confidence = parsed?.fieldConfidence?.[field];
    fields[field] = {
      present: typeof value === "string" && value.trim().length > 0,
      confidence: Number.isSafeInteger(confidence) ? Math.max(0, Math.min(100, confidence)) : 0,
    };
  }
  const report = {
    detectedLanguage: ["id", "en", "mixed", "unknown"].includes(parsed?.detectedLanguage) ? parsed.detectedLanguage : "unknown",
    fields,
  };
  if (expectedFields) report.expectedFieldsMatch = Object.entries(expectedFields).every(([field, expected]) => {
    if (typeof parsed?.[field] !== "string") return false;
    const actual = parsed[field].trim();
    if (field === "amount" && /^\d+(?:\.\d{1,6})?$/.test(actual)) {
      const [integer, fraction = ""] = actual.split(".");
      const canonical = integer.replace(/^0+(?=\d)/, "") + (fraction.replace(/0+$/, "") ? `.${fraction.replace(/0+$/, "")}` : "");
      return canonical === expected;
    }
    return actual.toUpperCase() === expected.toUpperCase();
  });
  return report;
}

export function isOcrSmokeReportAcceptable(report, thresholds) {
  if (!report || !report.fields || !thresholds || report.expectedFieldsMatch === false) return false;
  for (const field of ["vendor", "documentDate", "amount", "invoiceNumber"]) {
    const result = report.fields[field];
    const threshold = thresholds[field];
    if (!result?.present || !Number.isSafeInteger(result.confidence)
        || !Number.isSafeInteger(threshold) || result.confidence < threshold) {
      return false;
    }
  }
  return true;
}
