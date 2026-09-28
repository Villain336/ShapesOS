-- Marketr — Phase 13B (G0): Agent Learning + Company Intelligence data model.
-- Hand-written (prisma migrate dev's shadow DB lacks pgcrypto on this box;
-- see docs/phases/13b/DATA-MODEL.md). Purely additive: 4 new enums, 6 new
-- tables, 1 enum value on "MemoryLearningSource", FORCE RLS on all new
-- tables (same tenant-isolation pattern as phase8: app.workspace_id GUC).

-- Enums
CREATE TYPE "FeedbackKind" AS ENUM ('explicit_up', 'explicit_down', 'edit_diff', 'accepted', 'regenerated');
CREATE TYPE "KnowledgeKind" AS ENUM ('product', 'pricing', 'audience', 'competitor', 'pillar', 'proof', 'positioning', 'other');
CREATE TYPE "StyleRuleKind" AS ENUM ('ban', 'require', 'disclaimer', 'tone');
CREATE TYPE "StyleRuleSeverity" AS ENUM ('block', 'flag');

-- New source for memory_learnings: distilled by the nightly consolidation
-- pass (mirrors schema.prisma MemoryLearningSource.consolidation).
ALTER TYPE "MemoryLearningSource" ADD VALUE IF NOT EXISTS 'consolidation';

-- Feedback signals on agent-call episodes (spec §1).
CREATE TABLE "agent_feedback" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "episode_id" TEXT,
  "agent_id" TEXT NOT NULL,
  "kind" "FeedbackKind" NOT NULL,
  "signal" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_feedback_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "agent_feedback" ADD CONSTRAINT "agent_feedback_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_feedback" ADD CONSTRAINT "agent_feedback_episode_id_fkey"
  FOREIGN KEY ("episode_id") REFERENCES "memory_episodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "agent_feedback_workspace_id_created_at_idx" ON "agent_feedback"("workspace_id", "created_at");
CREATE INDEX "agent_feedback_workspace_id_kind_idx" ON "agent_feedback"("workspace_id", "kind");
CREATE INDEX "agent_feedback_workspace_id_episode_id_idx" ON "agent_feedback"("workspace_id", "episode_id");

-- Living brand voice profile, one row per workspace (spec §2).
CREATE TABLE "brand_voice_profiles" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "dimensions" JSONB NOT NULL,
  "derived_from" JSONB NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  "pinned_by_user" BOOLEAN NOT NULL DEFAULT false,
  "pending_updates" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "brand_voice_profiles_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "brand_voice_profiles" ADD CONSTRAINT "brand_voice_profiles_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "brand_voice_profiles_workspace_id_key" ON "brand_voice_profiles"("workspace_id");

-- Company knowledge graph entries (spec §2).
CREATE TABLE "company_knowledge" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "kind" "KnowledgeKind" NOT NULL,
  "title" TEXT NOT NULL,
  "body" JSONB NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  "pinned" BOOLEAN NOT NULL DEFAULT false,
  "source_episode_id" TEXT,
  "valid_from" TIMESTAMPTZ(3),
  "valid_to" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "company_knowledge_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "company_knowledge" ADD CONSTRAINT "company_knowledge_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "company_knowledge" ADD CONSTRAINT "company_knowledge_source_episode_id_fkey"
  FOREIGN KEY ("source_episode_id") REFERENCES "memory_episodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "company_knowledge_workspace_id_kind_idx" ON "company_knowledge"("workspace_id", "kind");
CREATE INDEX "company_knowledge_workspace_id_created_at_idx" ON "company_knowledge"("workspace_id", "created_at");

-- Hard style constraints, checked on every agent output pre-delivery (spec §2).
CREATE TABLE "style_rules" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "kind" "StyleRuleKind" NOT NULL,
  "pattern" TEXT NOT NULL,
  "replacement" TEXT,
  "severity" "StyleRuleSeverity" NOT NULL,
  "pinned" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "source" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "style_rules_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "style_rules" ADD CONSTRAINT "style_rules_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "style_rules_workspace_id_kind_active_idx" ON "style_rules"("workspace_id", "kind", "active");
CREATE INDEX "style_rules_workspace_id_created_at_idx" ON "style_rules"("workspace_id", "created_at");

-- Content memory: everything ever made for this company (spec §2).
CREATE TABLE "content_records" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body_ref" TEXT,
  "angle" TEXT,
  "channel" TEXT,
  "performance" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "content_records_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "content_records" ADD CONSTRAINT "content_records_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "content_records_workspace_id_created_at_idx" ON "content_records"("workspace_id", "created_at");
CREATE INDEX "content_records_workspace_id_kind_idx" ON "content_records"("workspace_id", "kind");

-- Persona voice/continuity profiles, per workspace (spec §5).
-- @@unique([workspaceId, agentId]) — see schema comment for the rationale.
CREATE TABLE "persona_profiles" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "agent_id" TEXT NOT NULL,
  "voice" JSONB NOT NULL,
  "continuity_notes" TEXT NOT NULL,
  "uncertainty_style" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "persona_profiles_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "persona_profiles" ADD CONSTRAINT "persona_profiles_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "persona_profiles_workspace_id_agent_id_key" ON "persona_profiles"("workspace_id", "agent_id");

-- ============================================================
-- RLS (spec §9.2): same tenant-isolation pattern as phase8.
-- ENABLE + FORCE so the table owner is also constrained; the tenant
-- principal is the app.workspace_id GUC. Sessions without the GUC see
-- ZERO rows (fail-closed). lib/substrate/memory/rls.ts sets it per
-- transaction via withWorkspaceScope().
-- ============================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'agent_feedback','brand_voice_profiles','company_knowledge',
    'style_rules','content_records','persona_profiles'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I FOR ALL ' ||
      'USING (workspace_id = current_setting(''app.workspace_id'', true)) ' ||
      'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t, t
    );
  END LOOP;
END $$;
