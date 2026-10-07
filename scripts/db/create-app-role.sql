-- ShapesOS — runtime app role (least privilege). The app must NOT connect as
-- the schema owner/superuser: superusers bypass every FORCE ROW LEVEL SECURITY
-- policy, silently disabling tenant isolation. Run as the migrator after
-- migrations, e.g.:
--   psql "$MIGRATOR_URL" -v app_password='…' -f scripts/db/create-app-role.sql
-- Idempotent; re-run after new migrations (grants cover new tables).
\if :{?app_role}
\else
  \set app_role marketr_app
\endif
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L',
              :'app_role', :'app_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role') \gexec
-- Refresh the password. A superuser migrator (compose, CI) also re-asserts
-- NOSUPERUSER NOBYPASSRLS. A managed-Postgres owner (Render's default user,
-- RDS's master user) is not a superuser, and PostgreSQL 16 refuses to let a
-- non-superuser even NAME the SUPERUSER attribute in ALTER ROLE ("Only roles
-- with the SUPERUSER attribute may change the SUPERUSER attribute"), so it
-- only sets the password; the check below still fails closed.
SELECT format('ALTER ROLE %I NOSUPERUSER NOBYPASSRLS PASSWORD %L', :'app_role', :'app_password')
 WHERE (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', :'app_role', :'app_password')
 WHERE NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) \gexec
-- Fail closed: an app role that is SUPERUSER or BYPASSRLS would silently
-- skip every FORCE ROW LEVEL SECURITY policy.
SELECT format($assert$DO $do$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = %L AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'app role %% is SUPERUSER or BYPASSRLS: it would bypass row-level security', %L;
  END IF;
END $do$$assert$, :'app_role', :'app_role') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_role') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'app_role') \gexec
SELECT format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I', :'app_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'app_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', :'app_role') \gexec
-- Phase 19B (WS=engine): sim_events (the town event log) is APPEND-ONLY for the
-- app role — the blanket grant above includes UPDATE / DELETE, so take them
-- back on every run of this script (rows still go with their run or
-- workspace: the FK cascade runs as the table owner).
SELECT format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM %I', 'sim_events', :'app_role')
 WHERE EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'sim_events') \gexec
-- Payload CMS keeps its tables in its own `payload` schema (payload.config.ts)
-- and connects with the same DATABASE_URL, i.e. as this role. Grant what
-- Payload needs there: read/write on its tables and
-- sequences, and CREATE so its schema sync can add tables. Payload tables
-- hold CMS content only (no tenant RLS), so this doesn't widen tenant access.
-- Create it (owned by the migrator running this script) on fresh installs, so
-- the grants below always apply and Payload never needs CREATE SCHEMA rights.
CREATE SCHEMA IF NOT EXISTS payload;
SELECT format('GRANT USAGE, CREATE ON SCHEMA payload TO %I', :'app_role')
 WHERE EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'payload') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA payload TO %I', :'app_role')
 WHERE EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'payload') \gexec
SELECT format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA payload TO %I', :'app_role')
 WHERE EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'payload') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA payload GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'app_role')
 WHERE EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'payload') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA payload GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', :'app_role')
 WHERE EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'payload') \gexec
