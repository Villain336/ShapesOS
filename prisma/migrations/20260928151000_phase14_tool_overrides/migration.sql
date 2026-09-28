-- Marketr — Phase 14 slice 2: per-workspace tool risk-tier overrides.
-- Additive: nullable JSONB column on workspace_settings; manual overrides
-- win over verb-derived classification (spec §3).
ALTER TABLE "workspace_settings" ADD COLUMN "tool_tier_overrides" JSONB;
