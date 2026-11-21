-- Reset DanaTerang operational data after migrating accounts to Supabase.
-- Keeps: organizations, users (email + password hash + role), schema_migrations.
-- Clears: campaigns, milestones, evidence, OCR, review, proofs, payment reports,
--         funding records, sessions, audit logs, and wallet bindings.
--
-- Run AFTER applying migrations and importing accounts:
--   npm run db:reset-app-data --workspace @dana-terang/api

BEGIN;

TRUNCATE TABLE
  audit_logs,
  payment_reports,
  campaign_funding_records,
  proofs,
  verifications,
  review_vote_submissions,
  review_votes,
  review_assignments,
  review_rounds,
  verifier_wallet_challenges,
  verifier_wallets,
  ocr_jobs,
  ai_flags,
  ocr_runs,
  evidence,
  milestones,
  campaigns,
  user_sessions,
  terms_acceptances
RESTART IDENTITY CASCADE;

-- Wallet bindings belong to the old operational run; Verifiers/Funders connect again.
UPDATE users SET wallet_address = NULL WHERE wallet_address IS NOT NULL;

COMMIT;
