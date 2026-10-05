-- ShapesOS — one-time migration-history repair (idempotent; safe on fresh DBs).
--
-- Two migrations were committed with timestamps that sorted before the
-- migrations they depend on, so a fresh `prisma migrate deploy` failed:
--   20261002012700_connector_slice5 (needs connector_slice4's enum/tables)
--   20261002032000_cad_slice4       (needs cad_slice2/cad_slice3)
-- They were renamed to sort after their dependencies. Databases that already
-- applied them under the old names get their history rows renamed here so
-- `migrate deploy` does not try to re-apply them. Run BEFORE migrate deploy.
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    UPDATE "_prisma_migrations"
       SET migration_name = '20261002013500_connector_slice5'
     WHERE migration_name = '20261002012700_connector_slice5';
    UPDATE "_prisma_migrations"
       SET migration_name = '20261002130000_cad_slice4'
     WHERE migration_name = '20261002032000_cad_slice4';
  END IF;
END $$;
