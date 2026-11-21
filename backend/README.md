# DanaTerang Backend — MVP Lomba

Backend memakai Node.js, Express 5, PostgreSQL, penyimpanan file privat, OCR lokal Indonesia/Inggris, dan ethers untuk quorum serta proof blockchain. Semua perintah di bawah dijalankan dari **root repositori**.

Panduan pembagian modul, kontrak adapter AI, dan handoff ke tim blockchain: [Integrasi AI OCR dan review blockchain](../docs/AI_OCR_INTEGRATION.md).

## 1. Setup lokal

Prasyarat: Node.js 20.19+ dan npm 10+. Jalur cepat menyediakan PostgreSQL native persisten tanpa instalasi service sistem:

```powershell
npm install
npm run setup:local
npm run dev
```

Database memakai port `55432`; data tersimpan di `.local/postgres`. Setup membuat `backend/.env` hanya jika belum ada, dengan credential acak yang juga tersimpan di `.local/development.json`, menjalankan seluruh migrasi, menyiapkan folder storage/model OCR, dan membuat Admin pertama (`admin@danaterang.local`). Setup berikutnya mempertahankan data serta akun. Buka `http://localhost:3000`. Kontrak Sepolia dan wallet tim tetap dikonfigurasi secara terpisah.

Untuk memakai instalasi PostgreSQL 16+ yang sudah ada, ikuti [panduan database](../database/README.md) dan langkah manual berikut:

```powershell
npm ci
Copy-Item backend/.env.example backend/.env
```

Isi `backend/.env`:

```dotenv
DATABASE_URL=postgres://danaterang_dev:PASSWORD_YANG_SUDAH_URL_ENCODED@127.0.0.1:5432/danaterang
WEB_ORIGIN=http://localhost:3000
OCR_LANGUAGE_DATA_PATH=../.local/tessdata
```

`dotenv` dijalankan dari workspace `backend/` oleh npm; path relatif storage dan model juga mengacu ke folder tersebut. Gunakan hostname frontend yang sama secara konsisten: `localhost` dan `127.0.0.1` adalah origin berbeda.

```powershell
npm run db:migrate --workspace @dana-terang/api
npm run ocr:setup --workspace @dana-terang/api
npm run ocr:smoke --workspace @dana-terang/api
```

`ocr:setup` mengambil `eng.traineddata` dan `ind.traineddata` dari distribusi resmi `tesseract-ocr/tessdata_best` ke folder lokal yang diabaikan Git. File yang sudah ada dilewati. Unduhan hanya dilakukan saat setup; worker aplikasi memakai model lokal. Tesseract.js dipin ke `6.0.1` karena smoke test pada Node 22/Windows menemukan abort fungsi SSE pada core `7.0.0`.

### AI OCR dengan Gemini

Untuk mengaktifkan koreksi field dan fallback vision, isi `backend/.env`:

```dotenv
GEMINI_ENABLED=true
GEMINI_API_KEY=ISI_API_KEY_GOOGLE_AI_STUDIO
GEMINI_MODEL=gemini-2.5-flash
```

Verifikasi koneksi dan akurasi pada receipt sintetis, lalu restart API:

```powershell
npm run ocr:smoke:ai --workspace @dana-terang/api
npm run dev:api
```

`ocr:smoke` menguji Tesseract lokal; `ocr:smoke:ai` benar-benar memanggil API Gemini dengan gambar sintetis. Kedua perintah memeriksa **nilai yang diharapkan dan confidence**, bukan sekadar field terisi. Smoke AI wajib menghasilkan `APPLIED` dan `expectedFieldsMatch: true`; exit `1` berarti konfigurasi, koneksi, kuota, atau ekstraksi belum berhasil. Output hanya berisi status dan hasil pemeriksaan, tanpa API key atau isi dokumen.

Gunakan `npm run ocr:smoke:formats --workspace @dana-terang/api` untuk memeriksa Tesseract asli pada PNG, JPEG, dan PDF hasil scan. Untuk memeriksa ketiga format melalui Gemini juga, jalankan `npm run ocr:smoke:ai:formats --workspace @dana-terang/api`. Script khusus ini memastikan flag format diteruskan juga oleh npm/PowerShell di Windows.

Pipeline memprioritaskan grand total/jumlah akhir, mengabaikan jumlah barang/subtotal/tunai/kembalian, dan membiarkan nominal ambigu tetap kosong. Gemini menerima PNG/JPEG dengan MIME yang sesuai, teks OCR maksimum 40.000 karakter, dan maksimal `GEMINI_MAX_PAGES` halaman pertama (default 4). PDF dibatasi 10 halaman. Permintaan AI dibatasi 18 MiB; respons JSON divalidasi terhadap field dan confidence 0–100. Nama model boleh memakai awalan `models/`, yang akan dinormalisasi otomatis.

Koreksi diterima dengan `GEMINI_FIELD_THRESHOLD`, sedangkan kelemahan hasil Tesseract dinilai dengan threshold **masing-masing field** dari `OCR_*_CONFIDENCE_THRESHOLD`. Mata uang juga memiliki confidence AI. Nilai desimal tetap string eksak. Retry memakai jeda 2 detik, HTTP 429 memicu cooldown, dan HTTP 401/403 menghentikan panggilan AI sampai server direstart setelah key diperbaiki.

Normalisasi/merge dipisahkan dari transport Gemini dalam `src/ocr/fieldMerge.js`. Nominal yang dipertahankan dari pembacaan lokal tidak dipasangkan dengan mata uang dari nominal AI yang berbeda. Confidence nominal mengabaikan digit quantity atau invoice yang hanya cocok sebagian; jika ada pembacaan nominal identik berulang, confidence yang paling rendah dipakai.

Ketika OCR lokal kosong atau engine gagal, gambar tetap dapat dibaca melalui vision. Teks mentah Tesseract tetap disimpan apa adanya; hasil vision hanya mengisi field. Pemulihan vision-only wajib mencakup seluruh halaman: bila melebihi `GEMINI_MAX_PAGES`, pulihkan OCR lokal atau naikkan batas halaman AI (maksimal 10) sebelum retry. Jika kedua pembaca gagal, evidence berstatus `PROCESSING_FAILED` dan dapat dicoba ulang oleh Admin. Kegagalan Gemini pada dokumen dengan OCR lokal yang tersedia tetap melanjutkan screening lokal.

Jika engine gagal pada halaman berikutnya, draf lokal sebelumnya dianggap parsial: field final dipulihkan dari vision seluruh dokumen, sementara nilai/confidence lokal tetap dicatat untuk perbandingan. Respons vision tanpa field yang dapat digunakan tidak meloloskan dokumen parsial sebagai berhasil.

Verifier yang ditugaskan dapat melihat status AI, model, sumber setiap field, confidence, serta perbedaan nilai Tesseract/Gemini pada detail review. Metadata disimpan pada `ocr_runs.ai_enrichment` dan tersedia melalui endpoint OCR privat. Screening tetap deterministik; keputusan akhir diberikan oleh quorum Verifier.

### Admin pertama

Isi `BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_ADMIN_EMAIL`, dan `BOOTSTRAP_ADMIN_PASSWORD` (12–128 karakter) di `.env`, kemudian:

```powershell
npm run admin:provision --workspace @dana-terang/api
npm run dev:api
```

API: `http://127.0.0.1:4000`; health: `GET /api/health`. Tanpa `DATABASE_URL`, server hanya berjalan dalam mode health-only. `npm run start --workspace @dana-terang/api` juga tersedia. Migrasi otomatis hanya aktif bila `NODE_ENV=development` dan `AUTO_MIGRATE=true`.

API menolak startup database-backed jika migrasi belum lengkap. Migrasi `011_vote_relay_recovery` menambahkan lease/jadwal retry; migrasi `012_payment_reports` menambahkan laporan pembayaran privat tanpa mengganti vote, keputusan, atau proof lama. Jalankan kembali `db:migrate` setelah memperbarui kode.

### Pemeriksaan kesiapan

```powershell
npm run doctor --workspace @dana-terang/api
```

`doctor` memeriksa prasyarat melalui query/read saja: koneksi database, seluruh migrasi, Admin aktif, tiga wallet Verifier aktif, storage, file model OCR, dan koneksi kedua kontrak. Perintah ini tidak menjalankan migrasi, membuat akun, menyalakan worker, atau mengirim transaksi. Exit code `0` berarti prasyarat lengkap; `1` berarti konfigurasi belum siap. Folder storage lokal dibuat ketika API dijalankan pertama kali.

Saat API aktif:

- `GET /api/health`: liveness proses, HTTP `200` termasuk mode health-only.
- `GET /api/ready`: kesiapan alur demo lengkap, HTTP `200` bila siap atau `503` bila ada komponen yang belum tersedia. Pemeriksaan runtime juga memeriksa worker OCR dan workflow berjalan.

Respons readiness hanya berisi kode status komponen (`ok`, `missing`, `not_configured`, `unavailable`, `not_running`); tidak memuat URL database/RPC, credential, path file, atau isi dokumen. Hasil dicache selama lima detik, request bersamaan memakai probe yang sama, dan setiap probe dibatasi waktu lima detik. `peerReview`/`proofAnchor` yang belum dikonfigurasi membuat readiness demo `503`, sementara fitur database yang sudah tersedia tetap dapat digunakan.

## 2. Menjalankan alur demo

1. Registrasikan Organizer, satu calon Funder, dan tiga calon Verifier, masing-masing dari organisasi berbeda. Registrasi publik selalu menghasilkan Organizer.
2. Login sebagai Admin dan ubah peran calon Funder/Verifier lewat `PATCH /api/admin/users/:userId/role`. Login ulang akun yang perannya diubah karena sesi lamanya dicabut.
3. Organizer memilih Funder dari `GET /api/funders`, membuat campaign dan milestone. Funder mengaktifkan campaign; Organizer mengubah milestone ke `IN_PROGRESS`.
4. Organizer mengunggah PDF/PNG/JPEG. API memvalidasi file, menyimpan byte privat dan SHA-256, lalu memasukkan pekerjaan OCR secara transaksional.
5. Tiga Verifier menghubungkan wallet yang ada pada roster kontrak. Wallet menandatangani challenge sekali pakai; kunci Verifier tetap di wallet masing-masing.
6. Worker membuka review pada kontrak setelah OCR selesai dan ketiga wallet siap. Dua keputusan bertanda tangan yang sama menyelesaikan quorum.
7. Quorum menghasilkan canonical proof schema 2; relayer mengirim commitment ke `ProofAnchor`. Status baru `ANCHORED` setelah receipt berhasil dan block number tersedia.
8. Admin mempublikasikan campaign. Public audit hanya menampilkan proyeksi metadata yang diizinkan.

### Sepolia

Isi kedua alamat kontrak dan konfigurasi relayer pada `.env`:

```dotenv
PEER_REVIEW_CONTRACT_ADDRESS=
PROOF_ANCHOR_CONTRACT_ADDRESS=
BLOCKCHAIN_RPC_URL=
BLOCKCHAIN_PRIVATE_KEY=
BLOCKCHAIN_CHAIN_ID=11155111
```

Kontrak dan skrip deployment berada di `packages/review-contract/`. Roster deployment berisi tiga alamat Verifier dan commitment organisasi yang sesuai ID organisasi database: `SHA-256("danaterang:organization:v1:<organizationId>")`. Skrip `packages/review-contract/scripts/deploy.js` mendukung `--organization-ids` untuk menghitungnya. Gunakan key service-wallet untuk relayer, dengan Sepolia ETH untuk gas. Startup memvalidasi chain, bytecode, serta identitas relayer.

Jika alamat peer-review belum diisi, endpoint review belum dipasang dan bukti menunggu. Jika alamat proof-anchor belum diisi, proof tetap `PENDING`. Setelah konfigurasi tersedia dan API direstart, worker melanjutkan dari data tersimpan. Gemini opsional melalui `GEMINI_ENABLED`; pengaturan lengkap ada di `.env.example`.

## 3. Kontrak API untuk frontend

Semua path memakai prefix `/api`. Autentikasi memakai cookie sesi `HttpOnly`; frontend harus menggunakan `credentials: "include"`. Request yang mengubah data wajib membawa `Origin` persis sama dengan `WEB_ORIGIN`. Nilai uang dikirim sebagai **string desimal**, bukan floating-point.

| Area | Endpoint utama | Akses |
| --- | --- | --- |
| Layanan | `GET /health`, `GET /ready` | Publik, status komponen saja |
| Auth | `POST /auth/register`, `/auth/login`, `/auth/logout`; `GET /auth/me` | Publik/sesi |
| Akun dan organisasi | `GET /admin/users`, `/admin/organizations`; `PATCH /admin/users/:id/role`, `/admin/organizations/:id/verification` | Admin |
| Campaign | `GET/POST /campaigns`, `GET/PATCH /campaigns/:id` | Sesuai peran dan organisasi |
| Aktivasi | `POST /campaigns/:id/activate` | Funder terkait |
| Milestone | `GET/POST /campaigns/:id/milestones`, `PATCH /milestones/:id` | Partisipan/Organizer pemilik |
| Bukti | `POST/GET /milestones/:id/evidence`, `GET /evidence/:id` | Sesuai peran dan organisasi |
| Revisi | `POST /evidence/:id/revisions` | Organizer pemilik setelah `NEEDS_REVISION` |
| Sumber dan OCR lengkap | `GET /evidence/:id/file`, `GET /evidence/:id/ocr` | Verifier yang ditugaskan |
| Retry OCR | `POST /admin/evidence/:id/ocr-retry` | Admin, sebelum review dibuka |
| Wallet | `GET/POST/DELETE /verifier/wallet`, `POST /verifier/wallet/challenge` | Verifier |
| Review | `GET /verifier/reviews`, `GET /verifier/reviews/:id` | Verifier yang ditugaskan |
| Vote | `POST /verifier/reviews/:id/votes/prepare`, `POST /verifier/reviews/:id/votes` | Verifier yang ditugaskan |
| Proof | `GET /evidence/:id/proof` | Partisipan terkait; Funder hanya ringkasan |
| Operasional | `GET /admin/reviews`, `GET /admin/proofs`, `POST /admin/proofs/:proofId/retry` | Admin, metadata saja |
| Publikasi | `GET /admin/campaigns`, `PATCH /admin/campaigns/:id/publication` | Admin |
| Audit publik | `GET /public/campaigns`, `GET /public/campaigns/:id` | Publik, campaign terpublikasi |
| Laporan pembayaran | `GET /payment-reports`; `POST /milestones/:id/payment-reports` | GET: partisipan terkait/Admin metadata; POST: Funder campaign |

Contoh payload registrasi:

```json
{
  "name": "Organizer Demo",
  "email": "organizer@example.test",
  "password": "password-lokal-pilihan-anda",
  "organizationName": "Komunitas Demo",
  "organizationType": "COMMUNITY",
  "acceptedTermsVersion": "2026-10-07-funder-terms-v1"
}
```

Upload memakai `multipart/form-data`: field `evidenceType=RECEIPT` dan satu file bernama field `file`, maksimum default 10 MiB. Vote memakai `decision`, `noConflictAttested: true`, dan `signature` dari typed data `/votes/prepare`. Untuk `NEEDS_REVISION`, sertakan pula `organizerInstructions` dan `instructionSalt` hasil prepare. Publikasi memakai `{ "published": true }`.

Respons gagal berbentuk `{ "error": "kode_error" }`. `401` berarti sesi diperlukan, `403` akses/origin ditolak, `404` data tidak ada/tidak dapat diakses, `409` konflik status, `413` terlalu besar, `429` rate limit, dan `503` layanan terkait belum tersedia. Vote mengembalikan `202` ketika pending/no-quorum dan `200` saat quorum selesai. Status screening, evidence, review, verification, milestone, dan proof merupakan state machine terpisah.

Verifier dapat memantau vote sendiri melalui `GET /verifier/reviews/:id` pada `ownVote.delivery`: `status`, `attemptCount`, `nextAttemptAt`, `lastErrorCode`, dan `transactionHash`. Ringkasan ini tidak berisi signature atau informasi vote privat milik Verifier lain. Rate limit operasi wallet/vote dihitung per akun Verifier agar akun independen yang memakai koneksi internet sama tidak saling memblokir. Wallet yang sudah dirujuk riwayat review mengembalikan `409 verifier_wallet_in_use` saat dilepas; identitas reviewer historis dipertahankan.

### Laporan pembayaran eksternal

Funder terkait dapat mencatat pembayaran setelah milestone memiliki bukti terkini berstatus `VERIFIED`, campaign `ACTIVE`/`COMPLETED`, dan milestone tidak dibatalkan. Contoh payload:

```json
{
  "requestId": "597ff565-0e48-4e5c-bafd-293a62cf1df1",
  "reportedAmount": "50000.25",
  "currency": "IDR",
  "paidAt": "2026-01-01",
  "transactionReference": "referensi-transfer-privat",
  "notes": "catatan opsional"
}
```

Laporan bersifat append-only dan selalu `PAYMENT_REPORTED`, dengan metode `MANUAL_BANK_TRANSFER`. Tidak ada transisi manual ke `CONFIRMED`. `paidAt` merupakan tanggal kalender menurut Funder, tidak boleh di masa depan. Jumlah kumulatif dibatasi anggaran milestone menggunakan aritmetika desimal eksak dan row lock PostgreSQL, termasuk request bersamaan. Request ulang dengan `requestId` dan isi identik mengembalikan laporan yang sama (`200`); data baru mengembalikan `201`. `GET /payment-reports` menyertakan `eligibleMilestones` dan sisa anggaran untuk form Funder. Referensi/catatan hanya tersedia bagi Funder terkait dan Organizer pemilik; Admin menerima metadata saja. Data pembayaran tidak masuk proyeksi publik atau canonical proof.

## 4. Worker dan pemulihan

`src/workers/workflowWorker.js` menjalankan tahap berikut setiap 30 detik:

1. Membentuk round untuk bukti `READY_FOR_REVIEW` yang belum mempunyai round; ini menangani wallet yang baru tersedia setelah OCR.
2. Mendaftarkan round yang menunggu konfirmasi chain.
3. Merekonsiliasi receipt vote. Outcome disimpan sebelum vote ditandai selesai agar kegagalan database dapat dicoba ulang.
4. Mengklaim dan mengirim ulang vote `QUEUED`/`FAILED` yang waktunya sudah tiba, memakai signature Verifier yang tersimpan.
5. Membuat proof yang terlewat setelah quorum tersimpan.
6. Mencoba proof pending/gagal dan memulihkan proof `ANCHORING`, termasuk hash transaksi yang hilang setelah crash dengan event `ProofAnchored`.

Hasil OCR, flag, audit, dan status `READY_FOR_REVIEW` di-commit sebelum handoff review dalam transaksi terpisah. Error adapter review tidak memaksa recognition diulang atau membatalkan hasil AI; workflow worker melanjutkan pembentukan round dari status tersimpan ketika integrasi tersedia kembali.

Satu siklus tidak tumpang tindih dengan siklus berikutnya. Kegagalan satu tahap tetap memberi kesempatan tahap lainnya berjalan. Shutdown menunggu worker aktif sebelum menutup pool dan kedua koneksi chain. Gunakan satu proses API/relayer untuk demo.

`src/review/voteRelay.js` memakai lease 120 detik untuk mengoordinasikan request HTTP dengan worker. Ada maksimum delapan percobaan klaim relay, dengan backoff mulai 30 detik, berlipat dua hingga maksimum 15 menit. Kegagalan satu vote tidak menghentikan pemrosesan vote lainnya. Payload dan domain EIP-712 diverifikasi kembali sebelum relay; backend tidak membuat atau mengubah keputusan Verifier.

Jika hash transaksi gagal tersimpan setelah broadcast, lease yang kedaluwarsa dapat diklaim lagi. Relay memeriksa `hasVoted`, event `VoteSubmitted`, serta receipt, termasuk ketika round sudah mencapai quorum. Vote yang sudah tercatat dengan keputusan/commitment berbeda menjadi konflik operasional dan tidak ditimpa. Vote yang belum dikirim saat round ditutup atau akun disuspend berhenti tanpa broadcast tambahan. Receipt yang masih menunggu tetap `SUBMITTED`.

`src/blockchain/relayer.js` menyediakan satu antrean signer yang dipakai kedua kontrak. Pengiriman berurutan menggunakan nonce pending yang dibaca tanpa cache dan nonce lokal berikutnya, sehingga request vote dan pekerjaan proof tidak memakai nonce yang sama. Menunggu receipt dilakukan di luar antrean pengiriman. RPC request dibatasi 10 detik; tunggu receipt dibatasi 60 detik sebelum diteruskan oleh recovery.

Recovery tidak mengubah keputusan quorum atau membuka ulang `NO_QUORUM`. Transaksi belum terkonfirmasi tetap pending. Proof retry dibatasi delapan percobaan pengiriman; menunggu receipt tidak mengirim transaksi baru. OCR parsial dan flag berulang dapat dipaketkan setelah quorum: flag code dideduplikasi, dan amount/currency yang belum lengkap menjadi pasangan `null` dengan confidence 0 di proof; pembacaan asli tetap ada pada record OCR privat.

## 5. Verifikasi

```powershell
npm test --workspace @dana-terang/api
npm run test:mvp --workspace @dana-terang/api
npm run db:start:local
npm run test:native --workspace @dana-terang/api
npm audit --workspace @dana-terang/api --omit=dev
```

`test:mvp` ikut berjalan dalam suite backend. Test ini menerapkan semua migrasi pada PostgreSQL WASM (PGlite), menjalankan Express lewat HTTP, menyimpan file sementara, memproses parsing/screening, dan menjalankan kedua kontrak pada EVM lokal dengan tanda tangan wallet asli. Test mencakup late wallet binding, callback proof yang terlewat, recovery receipt/hash transaksi, idempotensi, serta publikasi dan pembatasan data privat. Recognition default dibuat deterministik agar suite tidak membutuhkan model atau jaringan.

Skenario integrasi juga mencakup RPC putus sebelum pengiriman vote, retry signature tersimpan, hash vote hilang setelah broadcast, penghentian vote yang tidak diperlukan setelah quorum, tiga keputusan berbeda (`NO_QUORUM`), dan revisi versi 2 dengan proof baru sambil mempertahankan proof versi sebelumnya. Test terpisah memeriksa konflik nonce, lease/backoff, payload vote yang dimodifikasi, penolakan relay akun disuspend, serta readiness dan migrasi/rollback.

Untuk menguji alur yang sama dengan **Tesseract asli** setelah `ocr:setup`:

```powershell
$env:MVP_REAL_OCR="true"
$env:OCR_LANGUAGE_DATA_PATH="../.local/tessdata"
npm run test:mvp --workspace @dana-terang/api
Remove-Item Env:MVP_REAL_OCR
```

`test:native` menjalankan alur MVP dengan Tesseract asli serta tes laporan pembayaran pada PostgreSQL native dari `DATABASE_URL`. Role database harus dapat membuat database uji. Setiap fixture membuat database `danaterang_test_<id>` tersendiri dan menghapusnya setelah selesai; data aplikasi utama tidak dipakai sebagai fixture. Suite ini juga memeriksa transaksi pembayaran bersamaan, nominal besar tanpa kehilangan presisi, serta stabilitas tanggal kalender lintas timezone. Pengujian chain tetap memakai EVM lokal, sehingga receipt/Etherscan live perlu diverifikasi dengan konfigurasi Sepolia tim.

## 6. Menambah fitur atau memperbaiki modul

| Lokasi | Tanggung jawab |
| --- | --- |
| `src/app.js` | Komposisi router dan dependency injection; dapat dites tanpa membuka port |
| `src/server.js` | Membaca konfigurasi, membuat dependency nyata, menjalankan worker dan shutdown |
| `src/routes/` | Validasi HTTP, sesi/peran, pemetaan error, respons aman |
| `src/auth/`, `src/evidence/`, `src/review/`, `src/proof/` | Aturan dan orchestration fitur |
| `src/repositories/` | SQL, transaksi, persistensi dan proyeksi sesuai akses |
| `src/ocr/` | Rasterisasi, engine OCR, parser, screening, enrichment opsional |
| `src/ocr/fieldMerge.js` | Normalisasi, konsistensi pasangan nominal/mata uang, serta provenance hasil gabungan tanpa transport/database |
| `src/storage/` | Adapter storage lokal dan S3/R2 |
| `src/workers/` | Orchestration recovery yang dapat dites lewat `runOnce()` |
| `src/review/voteRelay.js` | Pengiriman signature tersimpan, lease/retry dan pemulihan receipt vote |
| `src/blockchain/` | Signer relayer bersama dan konfigurasi koneksi RPC |
| `src/runtime/` | Pemeriksaan kesiapan runtime yang dipakai API dan CLI doctor |
| `src/repositories/paymentRepository.js`, `src/routes/payments.js` | Laporan pembayaran eksternal, pembatasan anggaran/akses, dan idempotensi |
| `scripts/local-development.js` | Setup/start/stop PostgreSQL native lokal serta supervisor API/web |
| `../packages/domain/` | State machine bersama |
| `../packages/proof/` | Canonical schema dan hashing deterministik |
| `../database/migrations/` | Perubahan skema bernomor berikutnya dan pasangan rollback |

Untuk fitur baru, tambahkan fungsi repository/service, injeksikan dari `server.js`, lalu pasang router melalui `app.js`. Pertahankan otorisasi organisasi dan proyeksi respons di server. Tambahkan regression test untuk perubahan alur penting; gunakan `test/mvp/workflow.test.js` sebagai contoh integrasi lintas modul. Perubahan schema proof dibuat berversi agar proof lama tetap dapat diverifikasi.
