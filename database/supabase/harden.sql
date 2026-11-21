-- Supabase security hardening for DanaTerang.
--
-- Supabase grants default privileges on objects in the `public` schema to the
-- `anon`, `authenticated`, and `service_role` roles. DanaTerang is accessed only
-- through its own Express API; exposing these tables through Supabase's
-- auto-generated REST API would leak users, session digests, private OCR text,
-- evidence metadata, and payment reports without authentication.
--
-- Run this AFTER creating the project and BEFORE/AFTER applying migrations.
-- It is idempotent and safe on a plain PostgreSQL install: roles that do not
-- exist are skipped, so the statement is a no-op outside Supabase.
--
--   npm run db:supabase:harden --workspace @dana-terang/api
--
-- If you later intentionally enable Supabase REST/Realtime for selected tables,
-- re-grant those tables explicitly instead of restoring the defaults.

DO $supabase_harden$
DECLARE
  target_role text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', target_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', target_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', target_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', target_role);

      -- Objects created later (for example schema_migrations) must not inherit
      -- those grants again. current_user owns the tables created by db:migrate.
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM %I', current_user, target_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', current_user, target_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', current_user, target_role);
    END IF;
  END LOOP;
END
$supabase_harden$;
