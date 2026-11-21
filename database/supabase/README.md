# Migrasi Database ke Supabase

Panduan ini memindahkan database DanaTerang dari PostgreSQL lokal ke Supabase dengan **mempertahankan akun (email + password hash)** dan **menghapus data operasional** supaya alur dimulai dari awal.

Skema memakai 14 migrasi SQL di `database/migrations/`. Semuanya hanya `CREATE TABLE`, constraint, dan index — tanpa extension atau role khusus — sehingga kompatibel dengan Supabase Postgres.

> **Penting:** aplikasi ini tidak memakai Supabase Auth, Supabase JS client, maupun PostgREST. Semua akses lewat API Express + `pg`. Karena Supabase memberi grant default ke role `anon`/`authenticated` pada tabel di schema `public`, langkah **hardening** di bawah wajib dilakukan.

## 1. Ke mana API/kredensial Supabase dimasukkan?

**Jangan** masukkan Supabase Project URL, `anon key`, atau `service_role key` — aplikasi ini tidak menggunakannya.

Yang dipakai hanyalah **connection string PostgreSQL**, dan taruhnya di **`backend/.env`** (atau Environment Variables di Vercel), bukan di frontend:

```dotenv
# backend/.env — local
NODE_ENV=production
WEB_ORIGIN=http://localhost:3000
DATABASE_URL=postgresql://postgres:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres?sslmode=require
DATABASE_POOL_MAX=5
AUTO_MIGRATE=false
```

- `DATABASE_URL` → koneksi database (wajib).
- `DATABASE_POOL_MAX` → batas koneksi per proses (disarankan `5` untuk serverless).
- `WEB_ORIGIN` → origin frontend yang persis sama.
- `frontend/.env.local` sudah disiapkan dengan placeholder `NEXT_PUBLIC_SUPABASE_URL` dan `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Nilainya bisa langsung diisi dari **Supabase Dashboard → Project Settings → API**. Keduanya **belum dipakai** oleh kode saat ini (database tetap lewat backend `DATABASE_URL`), jadi mengisinya tidak mengubah perilaku aplikasi — disiapkan untuk pemakaian client-side berikutnya.
- Di Vercel: **Project → Settings → Environment Variables**, isi `DATABASE_URL`, `WEB_ORIGIN`, `DATABASE_POOL_MAX`, dan variabel backend lain. Jangan commit `.env`.

### Endpoint mana yang dipakai

| Endpoint | Port | Dipakai untuk |
|---|---|---|
| Direct / Session pooler | `5432` | Ekspor akun, hardening, **migrasi**, import akun, reset data |
| Transaction pooler | `6543` | Runtime API (Vercel/serverless) |

Password harus di-URL-encode dan `?sslmode=require` harus tetap ada.

```text
# Session pooler — untuk semua perintah migrasi di panduan ini
postgresql://postgres:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres?sslmode=require

# Transaction pooler — untuk API setelah semuanya selesai
postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?sslmode=require
```

## 2. Ekspor akun dari database lama (SEBELUM ganti DATABASE_URL)

Jalankan dari root repositori, sementara `backend/.env` masih mengarah ke database lokal:

```powershell
npm run db:export-accounts --workspace @dana-terang/api
```

Perintah ini menulis `database/supabase/accounts.sql` berisi INSERT untuk `organizations` dan `users` — termasuk `email_normalized` dan `password_hash` (hash scrypt, **bukan** plaintext). File ini **diabaikan Git** dan harus disimpan aman.

Kalau `DATABASE_URL` sudah terlanjur diganti, gunakan:

```powershell
$env:SOURCE_DATABASE_URL="postgres://...lama..."
npm run db:export-accounts --workspace @dana-terang/api
```

Wallet binding sengaja tidak disalin — Verifier dan Funder akan menghubungkan wallet lagi setelah migrasi.

## 3. Arahkan `backend/.env` ke Supabase

Ganti `DATABASE_URL` ke **session pooler port 5432** (lihat contoh di bagian 1).

## 4. Hardening schema `public` (wajib)

Jalankan sebelum migrasi pertama kali, supaya tabel baru tidak pernah mendapat grant publik:

```powershell
npm run db:supabase:harden --workspace @dana-terang/api
```

Script ini mencabut hak `anon`, `authenticated`, dan `service_role` atas schema `public` beserta default privilege-nya. Idempoten dan aman di PostgreSQL biasa. Verifikasi di SQL Editor:

```sql
SELECT table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated', 'service_role');
```

Hasilnya harus **0 baris**.

## 5. Jalankan migrasi

```powershell
npm run db:migrate --workspace @dana-terang/api
```

Verifikasi:

```sql
SELECT count(*) FROM schema_migrations;   -- harus 14
```

## 6. Import akun + hapus data operasional

```powershell
npm run db:import-accounts --workspace @dana-terang/api
npm run db:reset-app-data --workspace @dana-terang/api
```

`db:import-accounts` memasukkan organization & user (email + password + role + status) ke Supabase. `db:reset-app-data` lalu mengosongkan campaign, milestone, evidence, OCR, review, proof, payment report, funding record, session, audit log, dan wallet binding — **akun tetap utuh**.

Script reset menolak berjalan kalau tabel `schema_migrations` kosong, sebagai pengaman agar tidak menghapus database yang bukan DanaTerang.

Kalau tidak ada akun lama yang dipindahkan, lewati import dan buat Admin baru:

```dotenv
BOOTSTRAP_ADMIN_NAME=Admin
BOOTSTRAP_ADMIN_EMAIL=admin@domainkamu.com
BOOTSTRAP_ADMIN_PASSWORD=PASSWORD_MIN_12_KARAKTER
```

```powershell
npm run admin:provision --workspace @dana-terang/api
```

Semua akun yang dipindahkan perlu login ulang karena session lama ikut dihapus. Wallet binding juga ikut dihapus, jadi `doctor` akan menampilkan `verifierRoster: missing` sampai Admin menetapkan peran VERIFIER dan para Verifier menghubungkan wallet lagi.

## 7. Verifikasi

```powershell
npm run doctor --workspace @dana-terang/api
```

`database`, `migrations`, `admin`, `storage`, dan `ocr` harus `ok`. `peerReview`/`proofAnchor` boleh `not_configured` sampai kontrak dan RPC diisi.

## 8. Ganti ke transaction pooler untuk runtime

Ubah `DATABASE_URL` ke endpoint **port 6543**, lalu restart API:

```dotenv
DATABASE_URL=postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?sslmode=require
```

`DATABASE_POOL_MAX=5` mencegah banyak instance serverless melebihi batas koneksi pooler.

## 9. Catatan sebelum deploy ke Vercel

- **Storage:** `STORAGE_MODE=local` menulis ke filesystem yang ephemeral. Pakai bucket S3 / endpoint S3-compatible Supabase Storage lewat `STORAGE_MODE=s3`, `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`.
- **Worker background:** OCR queue dan workflow recovery adalah loop `setInterval` di proses API; Vercel serverless mematikannya setelah request. Perlu Vercel Cron atau backend Node terpisah.
- **Cookie session:** `dt_session` memakai `SameSite=Lax`. Kalau FE/BE beda domain, cookie tidak terkirim — paling aman proxy `/api/*` via rewrite Next.js (`API_INTERNAL_URL`).
- **Frontend:** `API_INTERNAL_URL` untuk rewrite server-side, `NEXT_PUBLIC_API_BASE_URL` kalau browser memanggil API langsung. `WEB_ORIGIN` harus persis sama dengan origin frontend.
- **Jangan** commit `.env` atau `accounts.sql` yang berisi password hash.

## 10. Catatan lingkungan saat migrasi

- Endpoint direct `db.[PROJECT_REF].supabase.co` bisa saja hanya memiliki record IPv6. Kalau lingkungan tidak punya jaringan IPv6 (`ENETUNREACH`), pakai **session pooler** `aws-0-[REGION].pooler.supabase.com:5432` dengan user `postgres.[PROJECT_REF]`.
- Di balik proxy korporat, verifikasi sertifikat TLS bisa gagal (`SELF_SIGNED_CERT_IN_CHAIN`). Untuk **perintah migrasi sekali jalan**, jalankan dengan `$env:NODE_TLS_REJECT_UNAUTHORIZED='0'` (PowerShell) di sesi tersebut. Jangan jadikan pengaturan permanen di produksi — di Vercel sertifikat normalnya terverifikasi.
- `pg` versi terbaru menganggap `sslmode=require` sebagai `verify-full`; ikuti peringatan di konsol bila perlu beralih ke `sslmode=verify-full` atau `uselibpqcompat=true&sslmode=require`.
