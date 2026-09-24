-- Physical attribution kit: vanity slugs must be globally unique.
--
-- GET /r/<slug> resolves the slug with no workspace key, so the old
-- per-workspace UNIQUE(workspace_id, vanity_slug) allowed two workspaces to
-- claim the same public URL and the lookup would resolve it to an arbitrary
-- tenant. A single global UNIQUE(vanity_slug) makes the public route
-- deterministic.
--
-- NOTE: the original P2 migration created the old uniqueness as a UNIQUE
-- INDEX (not a table constraint), so it is dropped with DROP INDEX.
DROP INDEX "attribution_bundle_workspace_id_vanity_slug_key";
CREATE UNIQUE INDEX "attribution_bundle_vanity_slug_key" ON "attribution_bundle"("vanity_slug");
