# Catatan progres DanaTerang

## Checkpoint integrasi AI OCR — 21 November 2026

- Branch khusus `backend/ocr` berbasis `origin/main` pada `be68a85`. Cakupan perubahan OCR dan integrasinya tercantum di [AI_OCR_INTEGRATION.md](AI_OCR_INTEGRATION.md#cakupan-branch-backendocr).
- Hasil OCR kini di-commit sebelum handoff review. Kegagalan SQL atau logging pada adapter review tidak membatalkan hasil AI; evidence tetap `READY_FOR_REVIEW` untuk recovery workflow.
- Normalisasi/merge dipisahkan ke `backend/src/ocr/fieldMerge.js`. Pasangan nominal/mata uang tidak lagi dicampur dari pembacaan yang saling bertentangan.
- Kegagalan recognition pada halaman berikutnya tidak lagi membuat field dari OCR parsial mengalahkan vision seluruh dokumen. Teks serta provenance lokal tetap dipertahankan; vision kosong membuat dokumen tetap retryable.
- Confidence nominal memakai token yang cocok lengkap, termasuk nominal terpecah oleh spasi; digit quantity/invoice tidak ikut menaikkan confidence.
- Panduan kontrak integrasi dan pembagian area kerja tersedia di [AI_OCR_INTEGRATION.md](AI_OCR_INTEGRATION.md).
- Catatan deployment Sepolia yang dibawa dari `main` berasal dari environment tim; konfigurasi lokal tetap dibaca dari `backend/.env` pada mesin masing-masing.

### Verifikasi checkpoint ini

| Pemeriksaan | Hasil |
| --- | --- |
| `npm test` | Lulus: browser end-to-end/axe, production build/TypeScript, 274 backend + 6 domain + 16 proof + 12 kontrak (308 tes Node, 0 gagal/dilewati) |
| `npm run test:native --workspace @dana-terang/api` | 7 tes lulus: PostgreSQL native, Tesseract asli, isolasi kegagalan handoff review, workflow EVM lokal, dan laporan pembayaran |
| `npm run ocr:smoke:formats --workspace @dana-terang/api` | PNG, JPEG, PDF sintetis lulus nilai yang diharapkan dan threshold confidence |
| `npm run ocr:smoke:ai:formats --workspace @dana-terang/api` | Gemini nyata (`gemini-flash-lite-latest`): ketiga format `APPLIED`, `expectedFieldsMatch: true`, masing-masing satu percobaan |
| Runtime setelah restart | Frontend/login/proxy health HTTP 200; database, migrations, admin, storage, OCR, workflow `ok` |
| Readiness lokal | HTTP 503: roster Verifier masih `missing`, peer-review/proof-anchor `not_configured` pada environment lokal |
| `git diff --check` | Lulus |

Script `ocr:smoke:ai:formats` ditambahkan agar npm/PowerShell Windows tidak kehilangan argumen `--all-formats`. Pengujian Gemini memakai dokumen sintetis; hasil ini bukan pengukuran akurasi pada seluruh dokumen lapangan atau transaksi Sepolia live.

## Checkpoint historis — 19 November 2026

### Implementasi dan runtime

- PostgreSQL native lokal berjalan pada `127.0.0.1:55432`, dengan data persisten di `.local/postgres`; seluruh **12 migrasi** sudah diterapkan.
- `npm run setup:local` menyiapkan database, Admin awal, storage dan model OCR. `npm run dev` menjalankan API dan frontend. Setup ulang mempertahankan data dan tidak menimpa konfigurasi database lain.
- Admin lokal: `admin@danaterang.local`; password acak tersedia di `.local/development.json` dan `backend/.env` (diabaikan Git).
- Saat checkpoint, web aktif di `http://localhost:3000`, API di `http://127.0.0.1:4000`. Login/logout Admin, halaman pengguna, publikasi, serta halaman laporan pembayaran diverifikasi lewat browser terhadap PostgreSQL native.
- Next.js diperbarui ke `16.4.6`; `follow-redirects` ke `1.16.3`. Audit seluruh dependensi: **0 kerentanan**.
- Dashboard mempertahankan hasil permintaan yang berhasil saat data lain gagal, menyediakan filter periode/status, dan memisahkan nominal per mata uang. Angka progres aktivitas tidak lagi dibuat sebagai persentase buatan.
- Ringkasan milestone/laporan tidak lagi mencampur mata uang. Notifikasi dicache per akun. Penanganan error laporan yang berulang dan peringatan rasio gambar diperbaiki.
- Detail campaign memuat proof untuk seluruh keputusan quorum (`VERIFIED`, `NEEDS_REVISION`, `REJECTED`), mempertahankan akses proof versi lama, menampilkan kegagalan pemuatan, serta memperbarui status asynchronous. Versi evidence yang sudah diganti tidak lagi menawarkan upload revisi.
- Migrasi `012_payment_reports` dan UI/API laporan Funder ditambahkan. Laporan append-only tetap `PAYMENT_REPORTED`, dibatasi anggaran, dapat dicoba ulang secara idempoten, dan disembunyikan dari pihak lain/publik. Admin melihat metadata tanpa referensi/catatan privat.
- Penguncian transaksi ditambahkan pada perubahan campaign/milestone dan pencatatan pembayaran sehingga request bersamaan tidak melampaui anggaran.
- Parser SQL `DATE` mempertahankan tanggal kalender sebagai string; tes native menemukan dan mengonfirmasi perbaikan pergeseran tanggal satu hari pada timezone lokal.
- Server uji browser menggunakan PostgreSQL WASM dengan lease koneksi yang melindungi transaksi penuh, menggantikan emulasi pg-mem pada alur tersebut. Runner Next.js mendeteksi lokasi paket workspace secara dinamis.

### Verifikasi selesai

| Pemeriksaan | Hasil |
| --- | --- |
| `npm test` | Lulus: browser + 237 backend + 6 domain + 16 proof + 12 kontrak (271 tes Node, 0 gagal/dilewati) |
| Browser Playwright/axe | Lulus alur role, upload, revisi/quorum, proof, laporan pembayaran privat, filter/mata uang; desktop/mobile tanpa pelanggaran axe |
| `npm run build` | Lulus production build dan TypeScript |
| `npm run test:native --workspace @dana-terang/api` | 6 tes lulus dengan PostgreSQL native, Tesseract asli, EVM lokal, konkurensi anggaran dan idempotensi |
| `npm run ocr:smoke --workspace @dana-terang/api` | Vendor/tanggal/nominal/invoice terdeteksi dan memenuhi threshold |
| Smoke browser runtime lokal | Login/logout Admin dan akses halaman lulus, database/storage/OCR/workflow `ok` |
| `npm audit` | 0 kerentanan |
| `git diff --check` | Lulus |

### Kebutuhan eksternal yang masih memblokir Sepolia live

Hasil `doctor` saat database/aplikasi aktif:

| Komponen | Status |
| --- | --- |
| database, migrations, admin, storage, ocr | ok |
| verifierRoster | missing |
| peerReview, proofAnchor | not_configured |

`GET /api/ready` juga melaporkan `workflow: ok`, tetapi tetap HTTP `503` karena prasyarat chain belum tersedia. Ini tidak diubah menjadi status sukses palsu.

Untuk menyelesaikan verifikasi live, tim perlu mengisi `PEER_REVIEW_CONTRACT_ADDRESS`, `PROOF_ANCHOR_CONTRACT_ADDRESS`, `BLOCKCHAIN_RPC_URL`, dan `BLOCKCHAIN_PRIVATE_KEY` relayer di `backend/.env`, menggunakan chain ID `11155111` dan relayer dengan Sepolia ETH. Siapkan tiga akun Verifier dari organisasi berbeda dan wallet yang sesuai roster/commitment deployment. Setelah restart, jalankan `doctor` lalu verifikasi receipt quorum dan anchor melalui Etherscan. Kunci Verifier tetap di wallet pemilik. Tes lokal di atas tidak merupakan transaksi Sepolia live.

---

## Checkpoint historis — 18 November 2026

Pekerjaan dijeda atas permintaan pengguna pada checkpoint ini.

## Posisi terakhir

- Commit terakhir saat pengecekan: `8dfdcc5` — UX workspace per peran, landing sesuai role, pencarian global, notifikasi, dan aksesibilitas.
- Perubahan backend terbaru tersimpan di working directory dan belum di-commit pada checkpoint ini.
- Fokus perubahan: recovery vote/proof blockchain, worker retry, relayer bersama untuk pengelolaan nonce, readiness API/CLI, dan dokumentasi backend MVP.
- Migrasi baru tersedia: `database/migrations/011_vote_relay_recovery.sql` beserta rollback.
- Panduan implementasi dan setup: `backend/README.md`.

## Verifikasi terakhir

Perintah dari root repositori:

```powershell
npm test --workspace @dana-terang/api
```

Hasil: **236 tes lulus, 0 gagal, 0 dilewati**. Termasuk alur integrasi upload → pemrosesan OCR → quorum 2 dari 3 Verifier → recovery proof → audit publik, memakai database PGlite dan EVM lokal. Recognition pada suite default dibuat deterministik; hasil ini bukan verifikasi OCR asli atau transaksi Sepolia live.

```powershell
npm run doctor --workspace @dana-terang/api
```

Hasil: `not_ready` (exit code 1).

| Komponen | Status |
| --- | --- |
| database | not_configured |
| migrations | unavailable |
| admin | unavailable |
| verifierRoster | unavailable |
| storage | unavailable |
| ocr | not_configured |
| peerReview | not_configured |
| proofAnchor | not_configured |

Tes frontend/browser belum dijalankan ulang pada checkpoint ini.

## Titik lanjut

1. Siapkan konfigurasi backend lokal mengikuti `backend/README.md` dan `database/README.md`.
2. Hubungkan PostgreSQL, jalankan migrasi, dan provision Admin pertama.
3. Siapkan storage, path model OCR, serta akun dan wallet tiga Verifier.
4. Konfigurasikan kontrak peer-review dan proof-anchor beserta RPC/relayer Sepolia, lalu jalankan kembali `doctor`.
5. Verifikasi alur lewat UI, OCR asli, dan receipt transaksi live.

Periksa `git status` sebelum melanjutkan untuk mengenali perubahan yang sudah tersimpan.
