-- Marketr — Phase 13D (Voice/text agents): LiveKit + VoiceStudio data model.
-- Hand-written (prisma migrate dev's shadow DB lacks pgcrypto on this box;
-- same approach as 20260927232000_phase13b_intelligence). Purely additive:
-- 5 new tables (voice_agents, call_scripts, call_sessions, voiceover_jobs,
-- pronunciation_entries), FORCE RLS on all new tables (same tenant-isolation
-- pattern as phase8/13b/13c: app.workspace_id GUC).
-- Reuses existing contact_consent (ContactConsent) for consent gating.

-- A configured agent: lead follow-up (voice/text) or voiceover narration.
CREATE TABLE "voice_agents" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "voice_id" TEXT NOT NULL,
  "voice_backend" TEXT NOT NULL DEFAULT 'voicestudio',
  "config" JSONB NOT NULL DEFAULT '{}',
  "kill_switch" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "voice_agents_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "voice_agents" ADD CONSTRAINT "voice_agents_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "voice_agents_workspace_id_purpose_status_idx" ON "voice_agents"("workspace_id", "purpose", "status");

-- Approved call scripts. Drafts can never dial.
CREATE TABLE "call_scripts" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "agent_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "body" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "approved_by" TEXT,
  "approved_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "call_scripts_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "call_scripts" ADD CONSTRAINT "call_scripts_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "call_scripts" ADD CONSTRAINT "call_scripts_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "voice_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "call_scripts_workspace_id_agent_id_status_idx" ON "call_scripts"("workspace_id", "agent_id", "status");

-- One voice/text session with a prospect. Consent-gated, full audit trail.
CREATE TABLE "call_sessions" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "agent_id" TEXT NOT NULL,
  "lead_id" TEXT NOT NULL,
  "script_id" TEXT,
  "channel" TEXT NOT NULL,
  "direction" TEXT NOT NULL DEFAULT 'outbound',
  "consent_proof" JSONB NOT NULL DEFAULT '{}',
  "transcript" JSONB NOT NULL DEFAULT '[]',
  "recording_ref" TEXT,
  "recording_consent" BOOLEAN NOT NULL DEFAULT false,
  "outcome" TEXT,
  "audit_trail" JSONB NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'rehearsal',
  "block_reason" TEXT,
  "started_at" TIMESTAMPTZ(3),
  "ended_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "call_sessions_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "voice_agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_lead_id_fkey"
  FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_script_id_fkey"
  FOREIGN KEY ("script_id") REFERENCES "call_scripts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "call_sessions_workspace_id_status_idx" ON "call_sessions"("workspace_id", "status");
CREATE INDEX "call_sessions_agent_id_created_at_idx" ON "call_sessions"("agent_id", "created_at");
CREATE INDEX "call_sessions_lead_id_idx" ON "call_sessions"("lead_id");

-- TTS narration jobs: script -> VoiceStudio -> audio attached to a clip.
CREATE TABLE "voiceover_jobs" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "agent_id" TEXT,
  "script" TEXT NOT NULL,
  "voice_id" TEXT NOT NULL,
  "voice_backend" TEXT NOT NULL DEFAULT 'voicestudio',
  "pronunciation" JSONB NOT NULL DEFAULT '[]',
  "audio_ref" TEXT,
  "clip_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "error" TEXT,
  "duration_sec" DOUBLE PRECISION,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "voiceover_jobs_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "voiceover_jobs" ADD CONSTRAINT "voiceover_jobs_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "voiceover_jobs" ADD CONSTRAINT "voiceover_jobs_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "voice_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "voiceover_jobs_workspace_id_status_idx" ON "voiceover_jobs"("workspace_id", "status");

-- Workspace pronunciation dictionary (seeded from 13B knowledge graph).
CREATE TABLE "pronunciation_entries" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "term" TEXT NOT NULL,
  "phonetic" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pronunciation_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pronunciation_entries_workspace_id_term_key" UNIQUE ("workspace_id", "term")
);
ALTER TABLE "pronunciation_entries" ADD CONSTRAINT "pronunciation_entries_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "pronunciation_entries_workspace_id_idx" ON "pronunciation_entries"("workspace_id");

-- ============================================================
-- RLS: same tenant-isolation pattern as phase8/13b/13c.
-- ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'voice_agents','call_scripts','call_sessions','voiceover_jobs','pronunciation_entries'
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
