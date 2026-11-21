# Integrasi AI OCR dan review blockchain

Panduan kerja bersama untuk pengembangan OCR dan blockchain. Implementasi memakai dependency injection dan antrean database yang sudah ada; tidak memerlukan RPC atau kontrak untuk menjalankan OCR.

## Cakupan branch `backend/ocr`

Basis branch adalah `origin/main` pada `be68a85`. Perubahan pada branch ini mencakup:

- Penggabungan hasil Tesseract/Gemini dan konsistensi pasangan nominal/mata uang dalam `backend/src/ocr/fieldMerge.js` dan `aiEnricher.js`.
- Confidence nominal dalam `documentParser.js`, serta pemulihan recognition multihalaman dalam `ocrWorker.js`.
- Persistensi hasil OCR sebelum handoff review melalui `backend/src/repositories/ocrRepository.js`, beserta wiring callback error OCR di `backend/src/server.js`.
- Pengujian regresi dalam `backend/test/ocr/`, penyesuaian tes handoff pada `backend/test/db/review-repository.test.js`, dan skenario kegagalan adapter setelah OCR pada `backend/test/mvp/workflow.test.js`.
- Script `ocr:smoke:ai:formats` dalam `backend/package.json`, panduan `backend/README.md`, dokumen ini, dan checkpoint OCR dalam `docs/PROGRESS.md`.

Perubahan pada file integrasi dan tes bersama mendukung alur penyelesaian OCR hingga `READY_FOR_REVIEW`. Saat meninjau perubahan, gunakan `git diff --cached origin/main` untuk changeset OCR yang sudah disiapkan di staging, lalu `git diff origin/main...backend/ocr` setelah changeset di-commit.

## Batas modul

| Modul | Tanggung jawab |
| --- | --- |
| `backend/src/ocr/documentRasterizer.js` | Membaca halaman PDF/PNG/JPEG dengan batas ukuran dan jumlah halaman |
| `backend/src/ocr/tesseractEngine.js` | Recognition lokal dan confidence kata |
| `backend/src/ocr/documentParser.js` | Ekstraksi awal dan confidence berdasarkan token yang sesuai |
| `backend/src/ocr/aiEnricher.js` | HTTP Gemini, schema respons, timeout, retry, dan cooldown |
| `backend/src/ocr/fieldMerge.js` | Normalisasi dan penggabungan field; fungsi murni tanpa HTTP/database/blockchain |
| `backend/src/ocr/ocrWorker.js` | Menjalankan pipeline melalui adapter engine/storage/enricher/repository |
| `backend/src/repositories/ocrRepository.js` | Menyimpan hasil OCR dan screening secara atomik |
| `backend/src/repositories/reviewRepository.js` | Membentuk round/assignment dari evidence yang siap |
| `backend/src/workers/workflowWorker.js` | Memulihkan handoff review, vote, dan proof yang tertunda |
| `backend/src/server.js` | Merakit dependency nyata untuk kedua area |

Perubahan alamat kontrak, RPC, ABI, dan pengiriman transaksi ditempatkan di konfigurasi atau adapter review/proof/blockchain. Modul OCR tidak perlu mengimpor kontrak tersebut.

## Urutan penyimpanan dan handoff

1. Upload menyimpan byte privat, hash, metadata evidence, dan pekerjaan OCR.
2. Worker membaca byte dan memverifikasi hash sebelum recognition.
3. OCR lokal dan Gemini menghasilkan field, confidence, serta provenance. Screening tetap deterministik.
4. Satu transaksi menyimpan `ocr_runs`, `ai_flags`, status job `COMPLETED`, status evidence `READY_FOR_REVIEW`, dan audit `OCR_COMPLETED`.
5. **Setelah transaksi tersebut commit**, adapter review opsional dipanggil dalam transaksi terpisah.
6. Jika adapter belum tersedia atau gagal, hasil OCR tetap tersimpan. `createWaitingRounds()` pada workflow worker mengambil evidence `READY_FOR_REVIEW` yang belum mempunyai round.

Handoff langsung mengambil row lock evidence dan melewati versi yang sudah mempunyai round. Recovery tidak membuka ulang keputusan final/`NO_QUORUM`. Audit pembuatan round disimpan oleh modul review melalui `REVIEW_ROUND_CREATED`; `OCR_COMPLETED.details.reviewRoundId` tetap `null` karena pencatatan OCR mendahului review.

`createOcrRepository(pool, { reviewRepository, onReviewError })` tetap menerima adapter `reviewRepository.createRound(client, { evidenceId, now })`. Adapter ini hanya melakukan operasi database dengan client transaksi yang diberikan; panggilan RPC dilakukan oleh service/worker review setelahnya. Callback `onReviewError` menerima `{ code: "OCR_REVIEW_HANDOFF_FAILED", evidenceId }`, bukan pesan SQL atau isi dokumen. Kegagalan callback logging juga tidak membatalkan OCR.

## Kontrak adapter AI

Worker menerima objek dengan fungsi asynchronous berikut:

```js
enricher.enrich({
  parsed,           // field lokal, detectedLanguage, fieldConfidence, extractedText
  text,             // teks asli Tesseract; bisa kosong atau parsial
  pages,            // array Buffer gambar, sesuai batas aiMaxPages
  thresholds,       // threshold screening masing-masing field
  localOcrComplete, // false jika recognition gagal pada salah satu halaman
});
// => { merged, ai }
```

- `merged` memakai field `vendor`, `documentDate`, `amount`, `currency`, `invoiceNumber`, `detectedLanguage`, dan `fieldConfidence` yang sudah digunakan repository/proof.
- `ai.status` tetap `APPLIED`, `UNAVAILABLE`, atau `DISABLED`. Metadata sumber/perbedaan/confidence tetap berada di `ai.fields` dan hanya tersedia lewat endpoint OCR privat untuk Verifier yang ditugaskan.
- Kegagalan AI mempertahankan hasil lokal yang tersedia. Jika OCR lokal tidak lengkap, adapter harus menghasilkan field dari vision seluruh dokumen, bukan menganggap draf parsial sebagai hasil lengkap.
- Worker selalu menyimpan teks asli Tesseract sebagai `extractedText`; koreksi AI tidak mengganti teks mentah tersebut.
- Jumlah dan mata uang merupakan satu pasangan. Saat kedua pembaca berbeda dalam nominal dan mata uang, pasangan AI diterima hanya jika kedua komponennya diterima. Jika tidak, pasangan lokal dipertahankan, termasuk mata uang `null` bila belum terbaca.
- Confidence nominal hanya memakai token angka lengkap atau rangkaian pecahan token yang benar-benar cocok dengan nominal. Digit quantity/invoice yang kebetulan merupakan substring tidak menaikkan confidence nominal.

## Kontrak yang dipertahankan saat integrasi

- Hash file dihitung dari byte asli; AI tidak mengubah `raw_hash` atau commitment versi evidence.
- `CLEAR`/`FLAGGED` adalah hasil screening, bukan keputusan quorum.
- Keputusan akhir tetap berasal dari Verifier melalui modul review; AI tidak menulis `VERIFIED` atau mengirim transaksi.
- Bentuk endpoint OCR, state machine, schema proof, dan migrasi yang sudah ada tetap kompatibel. Perubahan schema berikutnya perlu migrasi bernomor baru dan pasangan rollback.
- `backend/.env` dan credential tidak ikut Git. Deployment pada mesin lain tidak otomatis membuat RPC/kontrak/database lokal terkonfigurasi.

## Verifikasi sebelum menggabungkan perubahan

Dari root repositori:

```powershell
npm test
npm run ocr:smoke:formats --workspace @dana-terang/api
npm run ocr:smoke:ai:formats --workspace @dana-terang/api
npm run test:native --workspace @dana-terang/api
```

Smoke AI mengirim receipt sintetis ke Gemini nyata dan memeriksa `APPLIED`, nilai yang diharapkan, serta confidence; key diambil dari konfigurasi lokal. Suite native memakai database uji terpisah dan memerlukan PostgreSQL lokal berjalan. Alur MVP menguji kegagalan SQL pada adapter review setelah OCR selesai, rollback handoff yang terpisah, late wallet binding, quorum, recovery proof, dan idempotensi pada EVM lokal.

Health `200` menandakan API hidup. Readiness penuh dapat tetap `503` jika roster/kontrak belum siap; lihat detail komponen di `/api/ready` saat menguji integrasi blockchain.
