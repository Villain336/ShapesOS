-- ShapesOS Phase 4b: CAD derived bill of materials (lib/cad/bom-derive.ts).
-- A BOM version is now "manual" (tenant-entered) or "derived" (generated
-- from the pinned model version's real mesh geometry, with the derivation
-- lineage recorded). Derived lines carry per-unit volume/mass and the
-- measurement they cite; nulls mean "not computable", never zero.

ALTER TABLE "cad_bom_versions" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "cad_bom_versions" ADD COLUMN "derivation" JSONB;

ALTER TABLE "cad_bom_lines" ADD COLUMN "volume_mm3" DOUBLE PRECISION;
ALTER TABLE "cad_bom_lines" ADD COLUMN "mass_g" DOUBLE PRECISION;
ALTER TABLE "cad_bom_lines" ADD COLUMN "measurement" JSONB;

-- Record search (lib/search/records.ts, kind "bom_line"): the exact
-- expression the search SQL matches on. Name ends in _trgm_idx so the drift
-- guard treats it as an intentional raw-SQL index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "cad_bom_lines_part_trgm_idx" ON "cad_bom_lines"
  USING gin ((part_name || ' ' || coalesce(material_spec, '')) gin_trgm_ops);
