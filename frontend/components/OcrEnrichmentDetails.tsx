import { Fragment } from "react";

type FieldDecision = {
  source: "tesseract" | "gemini" | "none";
  diverged: boolean;
  geminiValue?: string | null;
  tesseractValue?: string | null;
  tesseractConfidence?: number | null;
  aiConfidence?: number;
};

export type OcrEnrichment = {
  status: "APPLIED" | "UNAVAILABLE" | "DISABLED";
  reason: string | null;
  model: string | null;
  pagesSent?: number;
  attempts?: number;
  durationMs?: number;
  ocrFailureCode?: string;
  visionFallback?: boolean;
  fields?: Record<string, FieldDecision> | null;
};

const FIELD_LABELS: Record<string, string> = {
  vendor: "Vendor", documentDate: "Tanggal", amount: "Jumlah", currency: "Mata uang", invoiceNumber: "Nomor invoice",
};

const REASONS: Record<string, string> = {
  GEMINI_DISABLED: "AI belum diaktifkan pada server.",
  TIMEOUT: "Batas waktu layanan AI terlampaui.",
  NETWORK: "Koneksi ke layanan AI terputus.",
  RATE_LIMITED: "Kuota AI sedang dibatasi; server menunggu sebelum mencoba dokumen berikutnya.",
  AUTH_FAILED: "Konfigurasi API key AI perlu diperiksa oleh pengelola.",
  AUTH_DISABLED: "AI dihentikan sementara sampai konfigurasi API key diperbaiki dan server direstart.",
  REQUEST_REJECTED: "Layanan AI menolak format permintaan.",
  REQUEST_TOO_LARGE: "Gambar melebihi batas ukuran permintaan AI.",
  MALFORMED_RESPONSE: "Respons AI tidak memenuhi format data yang diperlukan.",
  SERVER_ERROR: "Layanan AI sedang bermasalah.",
  ENRICHER_FAILURE: "Pemrosesan AI mengalami kesalahan.",
};

export default function OcrEnrichmentDetails({ ai }: { ai?: OcrEnrichment | null }) {
  if (!ai) return null;
  const fields = Object.entries(ai.fields ?? {}).filter(([field]) => field in FIELD_LABELS);
  const hasDivergence = fields.some(([, decision]) => decision.diverged);
  return (
    <section aria-label="Provenance AI OCR">
      <p className="field-hint">
        <strong>AI OCR: {ai.status === "APPLIED" ? "Gemini diterapkan" : ai.status === "DISABLED" ? "tidak diaktifkan" : "tidak tersedia"}</strong>
        {ai.model && <> · {ai.model}</>}
        {ai.status === "APPLIED" && <> · {ai.pagesSent ?? 0} halaman · {ai.attempts ?? 1} percobaan</>}
      </p>
      {ai.status !== "APPLIED" && <p className="field-hint">{REASONS[ai.reason ?? ""] ?? "Hasil menggunakan pembacaan OCR lokal yang tersedia."} Screening tetap memakai field yang berhasil dibaca.</p>}
      {ai.ocrFailureCode && <p className="field-hint">Field dipulihkan melalui vision karena OCR lokal gagal ({ai.ocrFailureCode}).</p>}
      {ai.visionFallback && !ai.ocrFailureCode && <p className="field-hint">Field dibaca melalui vision karena Tesseract tidak menghasilkan teks.</p>}
      {hasDivergence && <p className="field-hint"><strong>Ada perbedaan pembacaan Tesseract dan Gemini.</strong> Bandingkan dengan evidence asli sebelum memberikan keputusan.</p>}
      {fields.length > 0 && (
        <details className="technical-details" open={hasDivergence}>
          <summary>Sumber field dan perbandingan AI</summary>
          <dl>
            {fields.map(([field, decision]) => (
              <Fragment key={field}>
                <dt>{FIELD_LABELS[field]}</dt>
                <dd>
                  Sumber: {decision.source === "gemini" ? "Gemini" : decision.source === "tesseract" ? "Tesseract" : "belum terbaca"}
                  {decision.diverged && <>
                    {" · Pembacaan berbeda. Tesseract: "}{decision.tesseractValue ?? "tidak tersedia"}
                    {"; Gemini: "}{decision.geminiValue ?? "tidak tersedia"}
                  </>}
                  {" · Confidence Tesseract: "}{decision.tesseractConfidence ?? "tidak tersedia"}
                  {"; Gemini: "}{decision.aiConfidence ?? 0}/100
                </dd>
              </Fragment>
            ))}
          </dl>
        </details>
      )}
    </section>
  );
}
