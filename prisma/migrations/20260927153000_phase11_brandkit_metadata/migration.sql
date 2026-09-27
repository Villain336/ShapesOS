-- Marketr — Phase 11: brand-kit provenance metadata (Brandfetch import).
-- Stores { source, domain, logoUrl, fetchedAt } for kits created/augmented
-- from a Brandfetch domain lookup. JSONB, defaults to {} for existing rows.
ALTER TABLE "brand_kits" ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}';
