ALTER TABLE campaigns ALTER COLUMN funder_id DROP NOT NULL;
ALTER TABLE campaigns
  ADD COLUMN fundraising_status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED'
    CHECK (fundraising_status IN ('NOT_CONFIGURED', 'DRAFT', 'OPEN', 'LOCKED', 'CLOSED', 'CANCELLED')),
  ADD COLUMN cause_category TEXT NOT NULL DEFAULT 'OTHER'
    CHECK (cause_category IN ('DISASTER_RELIEF', 'EDUCATION', 'HEALTH', 'COMMUNITY', 'OTHER')),
  ADD COLUMN fundraising_close_at TIMESTAMPTZ,
  ADD COLUMN amendment_count SMALLINT NOT NULL DEFAULT 0 CHECK (amendment_count BETWEEN 0 AND 2),
  ADD COLUMN terms_locked_at TIMESTAMPTZ,
  ADD COLUMN terms_commitment TEXT CHECK (terms_commitment IS NULL OR length(terms_commitment) = 66),
  ADD COLUMN terms_lock_transaction_hash TEXT CHECK (terms_lock_transaction_hash IS NULL OR length(terms_lock_transaction_hash) = 66),
  ADD CONSTRAINT campaigns_fundraising_close_required CHECK (
    fundraising_status NOT IN ('OPEN', 'LOCKED', 'CLOSED') OR fundraising_close_at IS NOT NULL
  ),
  ADD CONSTRAINT campaigns_terms_lock_pair CHECK (
    (terms_locked_at IS NULL AND terms_commitment IS NULL)
    OR (terms_locked_at IS NOT NULL AND terms_commitment IS NOT NULL)
  );

CREATE INDEX campaigns_fundraising_status_close_idx ON campaigns(fundraising_status, fundraising_close_at);

CREATE TABLE campaign_revisions (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  amendment_number SMALLINT NOT NULL CHECK (amendment_number BETWEEN 0 AND 2),
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  snapshot JSONB NOT NULL,
  content_commitment TEXT NOT NULL CHECK (length(content_commitment) = 66),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (campaign_id, version),
  UNIQUE (campaign_id, amendment_number)
);

CREATE INDEX campaign_revisions_campaign_idx ON campaign_revisions(campaign_id, version DESC);

CREATE TABLE organization_payout_recipients (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_recipient_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'DISABLED')),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  verified_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (organization_id, provider),
  UNIQUE (provider, provider_recipient_id),
  CHECK ((status = 'ACTIVE' AND verified_by IS NOT NULL AND verified_at IS NOT NULL)
    OR (status <> 'ACTIVE' AND verified_by IS NULL AND verified_at IS NULL))
);

CREATE TABLE campaign_terms_signatures (
  id UUID PRIMARY KEY,
  campaign_revision_id UUID NOT NULL REFERENCES campaign_revisions(id) ON DELETE RESTRICT,
  signer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  signer_role TEXT NOT NULL DEFAULT 'ORGANIZER' CHECK (signer_role = 'ORGANIZER'),
  wallet_address TEXT NOT NULL CHECK (length(wallet_address) = 42 AND wallet_address = lower(wallet_address)),
  signature TEXT NOT NULL CHECK (length(signature) = 132),
  transaction_hash TEXT CHECK (transaction_hash IS NULL OR length(transaction_hash) = 66),
  signed_at TIMESTAMPTZ NOT NULL,
  UNIQUE (campaign_revision_id, signer_role),
  UNIQUE (wallet_address, campaign_revision_id)
);

CREATE TABLE fundraising_donations (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  donor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_payment_id TEXT,
  idempotency_key UUID NOT NULL,
  gross_amount NUMERIC(20, 2) NOT NULL CHECK (gross_amount > 0),
  provider_fee NUMERIC(20, 2) NOT NULL DEFAULT 0 CHECK (provider_fee >= 0),
  net_amount NUMERIC(20, 2) NOT NULL DEFAULT 0 CHECK (net_amount >= 0),
  currency TEXT NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
  reallocation_policy TEXT NOT NULL CHECK (reallocation_policy IN ('REDIRECT_RELATED', 'REFUND')),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PAID', 'FAILED', 'REFUND_PENDING', 'REFUNDED', 'CHARGEBACK')),
  checkout_url TEXT,
  provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  settled_at TIMESTAMPTZ,
  UNIQUE (donor_user_id, idempotency_key),
  UNIQUE (provider, provider_payment_id)
);

CREATE INDEX fundraising_donations_campaign_status_idx ON fundraising_donations(campaign_id, status);
CREATE INDEX fundraising_donations_donor_idx ON fundraising_donations(donor_user_id, created_at DESC);

CREATE TABLE fundraising_refunds (
  id UUID PRIMARY KEY,
  donation_id UUID NOT NULL UNIQUE REFERENCES fundraising_donations(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_refund_id TEXT,
  amount NUMERIC(20, 2) NOT NULL CHECK (amount > 0),
  fee_subsidy NUMERIC(20, 2) NOT NULL DEFAULT 0 CHECK (fee_subsidy >= 0 AND fee_subsidy <= amount),
  currency TEXT NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 80),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  settled_at TIMESTAMPTZ,
  UNIQUE (provider, provider_refund_id)
);

CREATE TABLE fundraising_ledger_transactions (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN (
    'DONATION_SETTLED', 'PROVIDER_FEE', 'MILESTONE_PAYOUT', 'REFUND',
    'SURPLUS_TRANSFER_OUT', 'SURPLUS_TRANSFER_IN', 'ADJUSTMENT'
  )),
  reference_type TEXT NOT NULL CHECK (reference_type IN ('DONATION', 'DISBURSEMENT', 'REFUND', 'TRANSFER', 'ADMIN_ADJUSTMENT')),
  reference_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (campaign_id, transaction_type, reference_type, reference_id)
);

CREATE TABLE fundraising_ledger_entries (
  id UUID PRIMARY KEY,
  transaction_id UUID NOT NULL REFERENCES fundraising_ledger_transactions(id) ON DELETE RESTRICT,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  account TEXT NOT NULL CHECK (account IN ('PAYMENT_CLEARING', 'DONATIONS', 'ESCROW', 'PROVIDER_FEES', 'MILESTONE_PAYOUTS', 'REFUNDS', 'CAUSE_TRANSFERS', 'PLATFORM_SUPPORT')),
  entry_side TEXT NOT NULL CHECK (entry_side IN ('DEBIT', 'CREDIT')),
  amount NUMERIC(20, 2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX fundraising_ledger_entries_campaign_idx ON fundraising_ledger_entries(campaign_id, account, created_at);
CREATE INDEX fundraising_ledger_entries_transaction_idx ON fundraising_ledger_entries(transaction_id);

CREATE TABLE fundraising_disbursements (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  milestone_id UUID NOT NULL REFERENCES milestones(id) ON DELETE RESTRICT,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_payout_id TEXT,
  idempotency_key UUID NOT NULL,
  amount NUMERIC(20, 2) NOT NULL CHECK (amount > 0),
  provider_fee NUMERIC(20, 2) NOT NULL DEFAULT 0 CHECK (provider_fee >= 0),
  currency TEXT NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'FAILED', 'CANCELLED')),
  recipient_reference TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  settled_at TIMESTAMPTZ,
  UNIQUE (provider, provider_payout_id),
  UNIQUE (requested_by, idempotency_key)
);

CREATE INDEX fundraising_disbursements_campaign_idx ON fundraising_disbursements(campaign_id, status);

CREATE TABLE fundraising_provider_events (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  provider_event_type TEXT NOT NULL,
  donation_id UUID REFERENCES fundraising_donations(id) ON DELETE RESTRICT,
  disbursement_id UUID REFERENCES fundraising_disbursements(id) ON DELETE RESTRICT,
  refund_id UUID REFERENCES fundraising_refunds(id) ON DELETE RESTRICT,
  received_at TIMESTAMPTZ NOT NULL,
  UNIQUE (provider, provider_event_id),
  CHECK (donation_id IS NOT NULL OR disbursement_id IS NOT NULL OR refund_id IS NOT NULL)
);

CREATE TABLE fundraising_surplus_transfers (
  id UUID PRIMARY KEY,
  source_campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  destination_campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  amount NUMERIC(20, 2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 5 AND 1000),
  status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'APPROVED', 'COMPLETED', 'REJECTED')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (source_campaign_id <> destination_campaign_id)
);

CREATE INDEX fundraising_surplus_transfers_source_idx ON fundraising_surplus_transfers(source_campaign_id, status);
CREATE INDEX fundraising_surplus_transfers_destination_idx ON fundraising_surplus_transfers(destination_campaign_id, status);
