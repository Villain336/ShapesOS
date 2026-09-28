-- Marketr — Phase 13C (Clipper): OpusClip-style video clipping data model.
-- Hand-written (prisma migrate dev's shadow DB lacks pgcrypto on this box;
-- same approach as 20260927232000_phase13b_intelligence). Purely additive:
-- 3 new tables (clip_sources, clips, clip_jobs), FORCE RLS on all new
-- tables (same tenant-isolation pattern as phase8/13b: app.workspace_id GUC).

-- Long-form video ingested for clipping.
CREATE TABLE "clip_sources" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "source_url" TEXT,
  "file_ref" TEXT,
  "duration_sec" DOUBLE PRECISION,
  "transcript_status" TEXT NOT NULL DEFAULT 'pending',
  "transcript" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "clip_sources_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "clip_sources" ADD CONSTRAINT "clip_sources_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "clip_sources_workspace_id_created_at_idx" ON "clip_sources"("workspace_id", "created_at");

-- Generated clip candidates: time window + virality score + caption
-- styling + render + approval/delivery state.
CREATE TABLE "clips" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "start_sec" DOUBLE PRECISION NOT NULL,
  "end_sec" DOUBLE PRECISION NOT NULL,
  "virality_score" DOUBLE PRECISION NOT NULL,
  "score_reasons" JSONB NOT NULL DEFAULT '[]',
  "caption_style" JSONB NOT NULL DEFAULT '{}',
  "captions" JSONB,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "render_status" TEXT NOT NULL DEFAULT 'pending',
  "output_ref" TEXT,
  "postiz_ref" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "clips_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "clips" ADD CONSTRAINT "clips_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "clips" ADD CONSTRAINT "clips_source_id_fkey"
  FOREIGN KEY ("source_id") REFERENCES "clip_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "clips_workspace_id_status_idx" ON "clips"("workspace_id", "status");
CREATE INDEX "clips_source_id_idx" ON "clips"("source_id");

-- Async pipeline work: transcribe / generate / render.
CREATE TABLE "clip_jobs" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "source_id" TEXT,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "error" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "clip_jobs_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "clip_jobs" ADD CONSTRAINT "clip_jobs_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "clip_jobs" ADD CONSTRAINT "clip_jobs_source_id_fkey"
  FOREIGN KEY ("source_id") REFERENCES "clip_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "clip_jobs_workspace_id_status_idx" ON "clip_jobs"("workspace_id", "status");

-- ============================================================
-- RLS (spec §9.2): same tenant-isolation pattern as phase8/13b.
-- ENABLE + FORCE so the table owner is also constrained; the tenant
-- principal is the app.workspace_id GUC. Sessions without the GUC see
-- ZERO rows (fail-closed). lib/substrate/memory/rls.ts sets it per
-- transaction via withWorkspaceScope().
-- ============================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'clip_sources','clips','clip_jobs'
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
