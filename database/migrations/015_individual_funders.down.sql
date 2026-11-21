ALTER TABLE users DROP CONSTRAINT users_organization_requirement_check;

ALTER TABLE users ADD CONSTRAINT users_check CHECK (
  (role = 'ADMIN' AND organization_id IS NULL)
  OR (role <> 'ADMIN' AND organization_id IS NOT NULL)
);
