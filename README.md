# DanaTerang

DanaTerang is an evidence-first accountability platform for funded programs. The workflow supports authentication and roles, organization-scoped campaigns/milestones, private evidence upload with exact-byte SHA-256, Indonesian/English OCR, version-specific signed 2-of-3 peer review, versioned proofs, Admin-published public audit, and private external-payment reports. Live Sepolia operation requires the team's deployed contracts, RPC, relayer and Verifier wallets.

## Mulai cepat di Windows

Jalankan dari root repositori dengan Node.js 20.19+ dan npm 10+:

```powershell
npm install
npm run setup:local
npm run dev
```

Buka **http://localhost:3000**. Setup menyediakan PostgreSQL native pada `127.0.0.1:55432`, menerapkan migrasi, membuat Admin pertama, serta menyiapkan model OCR lokal. Database dan file privat tetap tersimpan di `.local/` setelah aplikasi dihentikan. Email Admin lokal: `admin@danaterang.local`; password acak tersimpan di `.local/development.json` dan `backend/.env` yang diabaikan Git.

Setup dapat diulang tanpa menghapus data. Jika `backend/.env` sudah memakai database lain, file tersebut dipertahankan; jalankan layanan database Anda lalu gunakan `dev:api` dan `dev:web`. Konfigurasi Sepolia dijelaskan di [backend/README.md](backend/README.md#sepolia). Tanpa konfigurasi tersebut, upload/OCR dan pengelolaan campaign dapat digunakan; review on-chain dan anchoring tetap menunggu.

Untuk menjalankan database lokal saja: `npm run db:start:local`; hentikan dengan `npm run db:stop:local`. `npm run dev` menghentikan server aplikasi dan database yang dimulainya ketika menerima Ctrl+C.

## Development

Panduan backend MVP, kontrak API untuk frontend, pengujian alur lengkap, dan peta modul pengembangan tersedia di [backend/README.md](backend/README.md).

Requirements: Node.js 20.19+ and npm 10+.

The quick setup includes native PostgreSQL. To use an existing PostgreSQL 16+ installation instead, follow `database/README.md`. This project does not require Docker.

The local setup provisions only the first Admin. Register participants and assign Funder/Verifier roles through the Admin UI. For manual setup, follow `database/README.md` to apply migrations and provision the Admin using your chosen password.

Install browser-test prerequisites once before running the full workspace suite:

```sh
python -m pip install -r frontend/requirements-test.txt
python -m playwright install chromium
```

```sh
npm install
npm test
npm run dev:api
npm run dev:web
```

The `packages/proof` workspace implements canonical proof schemas 1 (legacy) and 2 (peer-quorum bound) plus raw-file hashing. `packages/domain` validates independent workflow status machines. `backend/` contains the Express API, private storage adapters, and local OCR worker; `frontend/` contains the Next.js app; and `database/migrations/` contains PostgreSQL migrations. Copy `backend/.env.example` and `frontend/.env.example` to local `.env` files and fill only the settings needed for the service you run. Follow `database/README.md` to provision local OCR language data and run the synthetic receipt smoke test. The public audit page shows only campaigns explicitly published by an Admin; unpublished campaigns remain private.

## Peer review

Each evidence version is assigned to three Verifiers from independent Organizations. Verifiers bind organization-controlled wallets with one-time typed-data challenges and sign votes locally; the backend relays signatures but cannot choose a result. Two matching decisions finalize on the contract. If quorum is not reached, verification remains pending without an Admin override. Admin review operations expose identifiers, status, counts, and timestamps only; source files and full OCR are limited to assigned Verifiers, while Funders see status only and Organizers see final instructions for their own revisions.

To enable the API's Sepolia integration, set `PEER_REVIEW_CONTRACT_ADDRESS`, `BLOCKCHAIN_RPC_URL`, `BLOCKCHAIN_PRIVATE_KEY`, and `BLOCKCHAIN_CHAIN_ID` in an untracked backend `.env` or secret store. Startup checks the configured chain, deployed contract, and relayer identity. Never use a real Verifier key in the service; Verifier keys stay in their wallets. The initial three wallet addresses and Organization commitments are fixed at contract deployment and are not selected by the Admin UI.
