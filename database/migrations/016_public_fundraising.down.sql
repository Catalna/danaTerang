DROP TABLE IF EXISTS fundraising_surplus_transfers;
DROP TABLE IF EXISTS fundraising_provider_events;
DROP TABLE IF EXISTS fundraising_refunds;
DROP TABLE IF EXISTS fundraising_disbursements;
DROP TABLE IF EXISTS fundraising_ledger_entries;
DROP TABLE IF EXISTS fundraising_ledger_transactions;
DROP TABLE IF EXISTS fundraising_donations;
DROP TABLE IF EXISTS campaign_terms_signatures;
DROP TABLE IF EXISTS organization_payout_recipients;
DROP TABLE IF EXISTS campaign_revisions;
DROP INDEX IF EXISTS campaigns_fundraising_status_close_idx;
ALTER TABLE campaigns
  DROP COLUMN IF EXISTS terms_lock_transaction_hash,
  DROP COLUMN IF EXISTS terms_commitment,
  DROP COLUMN IF EXISTS terms_locked_at,
  DROP COLUMN IF EXISTS amendment_count,
  DROP COLUMN IF EXISTS fundraising_close_at,
  DROP COLUMN IF EXISTS fundraising_status,
  DROP COLUMN IF EXISTS cause_category;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM campaigns WHERE funder_id IS NULL) THEN
    RAISE EXCEPTION 'Cannot roll back public fundraising while campaigns without a single funder exist';
  END IF;
END $$;
ALTER TABLE campaigns ALTER COLUMN funder_id SET NOT NULL;
