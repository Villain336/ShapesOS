-- Marketr — Phase 10 follow-up: harden the volume_cache RLS policy.
--
-- The tenant tables' equality policy (`workspace_id = current_setting(...)`)
-- is fail-closed under every GUC state, but volume_cache's presence policy
-- (`current_setting('app.workspace_id', true) IS NOT NULL`) was not: on this
-- PostgreSQL build a custom GUC placeholder never returns to NULL once
-- created in a session — after `set_config(..., is_local=true)` (SET LOCAL)
-- commits, current_setting() yields '' instead of NULL. Prisma reuses pooled
-- connections, and lib/substrate/graph/rls.ts pins the GUC per transaction,
-- so a recycled connection would carry '' and pass a bare IS NOT NULL check —
-- leaking shared cache rows across the pool.
--
-- The nullif(..., '') guard makes both the never-set (NULL) and the
-- post-transaction ('') states fail closed. Verified: no-GUC session sees
-- zero rows; '' GUC session sees zero rows; GUC-pinned session reads/writes
-- normally.

DROP POLICY IF EXISTS volume_cache_fail_closed ON "volume_cache";
CREATE POLICY volume_cache_fail_closed ON "volume_cache" FOR ALL
  USING (nullif(current_setting('app.workspace_id', true), '') IS NOT NULL)
  WITH CHECK (nullif(current_setting('app.workspace_id', true), '') IS NOT NULL);
