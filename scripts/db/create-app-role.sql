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
SELECT format('ALTER ROLE %I NOSUPERUSER NOBYPASSRLS PASSWORD %L', :'app_role', :'app_password') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_role') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'app_role') \gexec
SELECT format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I', :'app_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'app_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', :'app_role') \gexec
