ALTER TABLE users DROP CONSTRAINT users_check;

ALTER TABLE users ADD CONSTRAINT users_organization_requirement_check CHECK (
  (role = 'ADMIN' AND organization_id IS NULL)
  OR role = 'FUNDER'
  OR (role NOT IN ('ADMIN', 'FUNDER') AND organization_id IS NOT NULL)
);
