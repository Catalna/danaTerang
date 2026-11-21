# Migrasi Database ke Supabase

Panduan ini memindahkan database DanaTerang dari PostgreSQL lokal ke Supabase. Skema memakai 13 migrasi SQL di `database/migrations/` — semuanya hanya `CREATE TABLE`, constraint, dan index, tanpa extension atau role khusus, sehingga kompatibel dengan Supabase Postgres.

> **Penting:** aplikasi ini tidak memakai Supabase Auth/PostgREST. Semua akses lewat API Express sendiri. Karena Supabase memberi grant default ke role `anon`/`authenticated` pada tabel di schema `public`, langkah **hardening** di bawah wajib dilakukan supaya tabel privat tidak bisa dibaca lewat REST Supabase.

## 1. Siapkan project Supabase

1. Buat project di https://supabase.com/dashboard (region terdekat, mis. Singapore untuk Indonesia).
2. Simpan database password di pengelola kunci — tidak akan ditampilkan lagi.
3. Buka **Project Settings → Database → Connection strings**. Ada tiga endpoint:

| Endpoint | Port | Dipakai untuk |
|---|---|---|
| Direct / Session pooler | `5432` | **Menjalankan migrasi** dan `admin:provision` |
| Transaction pooler | `6543` | Runtime API (serverless/Vercel) |

Format string koneksi (URL-encode password dulu):

```text
# Session pooler — untuk migrasi
postgresql://postgres:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres?sslmode=require

# Transaction pooler — untuk API
postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?sslmode=require
```

Supabase mengharuskan TLS; `?sslmode=require` harus tetap ada.

## 2. Isi `backend/.env` (lokal)

```dotenv
NODE_ENV=production
WEB_ORIGIN=http://localhost:3000
DATABASE_URL=postgresql://postgres:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres?sslmode=require
DATABASE_POOL_MAX=5
AUTO_MIGRATE=false
```

Jalankan semua perintah dari **root repositori**. `AUTO_MIGRATE` harus `false` di production — migrasi dijalankan eksplisit.

## 3. Hardening schema `public` (wajib)

Jalankan **sebelum** migrasi pertama kali, agar tabel baru tidak pernah mendapat grant publik:

```powershell
npm run db:supabase:harden --workspace @dana-terang/api
```

Script ini menjalankan `database/supabase/harden.sql`: mencabut hak `anon`, `authenticated`, dan `service_role` atas schema `public` beserta default privilege-nya. Idempoten dan aman di PostgreSQL biasa (role yang tidak ada dilewati). Kalau kamu sudah lebih dulu menjalankan migrasi, jalankan script ini juga — ia mencabut grant pada tabel yang sudah ada.

Verifikasi di Supabase SQL Editor:

```sql
SELECT table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated', 'service_role');
```

Hasilnya harus **0 baris**.

## 4. Jalankan migrasi

```powershell
npm run db:migrate --workspace @dana-terang/api
```

Runner mencatat ID di tabel `schema_migrations` dan hanya menjalankan migrasi yang belum terpasang. Verifikasi:

```sql
SELECT count(*) FROM schema_migrations;   -- harus 13
```

Kalau gagal, cek: password URL-encoded, `sslmode=require`, endpoint **port 5432**, dan role yang dipakai boleh membuat tabel di schema `public`.

## 5. Admin pertama

Isi di `backend/.env`:

```dotenv
BOOTSTRAP_ADMIN_NAME=Admin
BOOTSTRAP_ADMIN_EMAIL=admin@domainkamu.com
BOOTSTRAP_ADMIN_PASSWORD=PASSWORD_MIN_12_KARAKTER
```

Lalu:

```powershell
npm run admin:provision --workspace @dana-terang/api
```

Provisioning hanya sekali dan tidak mengembalikan password. Simpan kredensialmu sendiri.

## 6. Verifikasi

```powershell
npm run doctor --workspace @dana-terang/api
```

`database`, `migrations`, `admin`, `storage`, dan `ocr` harus `ok`. `peerReview`/`proofAnchor` boleh `not_configured` sampai kontrak dan RPC diisi.

## 7. Ganti ke transaction pooler untuk runtime

Setelah migrasi selesai, ubah `DATABASE_URL` di `.env` produksi ke endpoint **port 6543**:

```dotenv
DATABASE_URL=postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?sslmode=require
```

Restart API. `DATABASE_POOL_MAX=5` mencegah banyak instance serverless melebihi batas koneksi pooler.

## 8. Catatan sebelum deploy ke Vercel

Ini di luar migrasi database, tapi harus disiapkan supaya deploy benar-benar jalan:

- **Storage:** `STORAGE_MODE=local` menulis ke filesystem yang ephemeral di Vercel. Pakai bucket S3 (atau endpoint S3-compatible Supabase Storage) lewat `STORAGE_MODE=s3`, `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`.
- **Worker background:** OCR queue dan workflow recovery (review/anchor retry) adalah loop `setInterval` di dalam proses API. Vercel serverless mematikan proses setelah request selesai. Perlu Vercel Cron yang memanggil endpoint worker, atau menjalankan backend sebagai layanan Node terpisah.
- **Cookie session:** cookie `dt_session` memakai `SameSite=Lax`. Kalau frontend dan backend di domain berbeda, cookie tidak ikut terkirim. Paling aman: proxy `/api/*` lewat rewrite Next.js supaya same-origin (`API_INTERNAL_URL`), atau ubah cookie ke `SameSite=None; Secure`.
- **Frontend:** set `API_INTERNAL_URL` ke alamat backend untuk rewrite server-side, dan `NEXT_PUBLIC_API_BASE_URL` kalau browser harus memanggil API langsung. `WEB_ORIGIN` di backend harus persis sama dengan origin frontend (skema + host + port).
- **Jangan** menyimpan `.env` dengan password database atau private key ke Git.
