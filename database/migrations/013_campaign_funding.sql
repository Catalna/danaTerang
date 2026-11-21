CREATE TABLE campaign_funding_records (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL UNIQUE REFERENCES campaigns(id) ON DELETE RESTRICT,
  content_commitment TEXT NOT NULL CHECK (length(content_commitment) = 66),
  funder_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  funder_wallet TEXT NOT NULL CHECK (length(funder_wallet) = 42 AND funder_wallet = lower(funder_wallet)),
  registry_address TEXT NOT NULL CHECK (length(registry_address) = 42 AND registry_address = lower(registry_address)),
  eip712_signature TEXT NOT NULL CHECK (length(eip712_signature) = 132),
  status TEXT NOT NULL CHECK (status IN ('ANCHORED')),
  transaction_hash TEXT NOT NULL CHECK (length(transaction_hash) = 66),
  block_number BIGINT NOT NULL CHECK (block_number >= 0),
  funding_version INTEGER NOT NULL DEFAULT 1 CHECK (funding_version >= 1),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX campaign_funding_records_campaign_idx ON campaign_funding_records(campaign_id);
