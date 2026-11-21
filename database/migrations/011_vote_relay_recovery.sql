ALTER TABLE review_vote_submissions ADD COLUMN relay_lease_owner UUID;
ALTER TABLE review_vote_submissions ADD COLUMN relay_lease_expires_at TIMESTAMPTZ;
ALTER TABLE review_vote_submissions ADD COLUMN next_attempt_at TIMESTAMPTZ;
ALTER TABLE review_vote_submissions ADD CONSTRAINT vote_relay_lease_pair CHECK (
  (relay_lease_owner IS NULL AND relay_lease_expires_at IS NULL)
  OR (relay_lease_owner IS NOT NULL AND relay_lease_expires_at IS NOT NULL)
);
CREATE INDEX review_vote_submissions_retry_idx ON review_vote_submissions(status, next_attempt_at, updated_at);
