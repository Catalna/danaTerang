CREATE TABLE payment_reports (
  id UUID PRIMARY KEY,
  milestone_id UUID NOT NULL REFERENCES milestones(id) ON DELETE RESTRICT,
  reporter_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id UUID NOT NULL,
  reported_amount NUMERIC(20, 2) NOT NULL CHECK (reported_amount > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  status TEXT NOT NULL DEFAULT 'PAYMENT_REPORTED' CHECK (status = 'PAYMENT_REPORTED'),
  method TEXT NOT NULL DEFAULT 'MANUAL_BANK_TRANSFER' CHECK (method = 'MANUAL_BANK_TRANSFER'),
  paid_at DATE NOT NULL,
  transaction_reference TEXT NOT NULL CHECK (length(trim(transaction_reference)) BETWEEN 1 AND 200),
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (reporter_user_id, request_id)
);

CREATE INDEX payment_reports_milestone_idx ON payment_reports(milestone_id);
CREATE INDEX payment_reports_reporter_idx ON payment_reports(reporter_user_id);
