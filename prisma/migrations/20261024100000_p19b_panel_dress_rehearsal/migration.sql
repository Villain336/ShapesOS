-- ShapesOS Phase 19B (WS=panel): Dress Rehearsal — the Pre Launch Panel
-- (lib/panel, commercial layer, entitlement dress_rehearsal).
-- panel_transcripts (verbatim interviews), panel_memory_nodes (the memory
-- stream, 384-d MiniLM pgvector embeddings), panel_personas, panel_runs,
-- panel_steps, panel_verdicts, panel_calibrations (the track record).
-- Every table cascades from workspaces and is FORCE RLS on the
-- app.workspace_id GUC (fail-closed: no GUC = zero rows).

CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "panel_transcripts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "interviewee" TEXT,
    "source" TEXT NOT NULL DEFAULT 'upload',
    "source_ref" TEXT,
    "text" TEXT NOT NULL,
    "char_count" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "panel_transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "panel_memory_nodes" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "transcript_id" TEXT,
    "run_id" TEXT,
    "persona_key" TEXT,
    "lens" TEXT,
    "node_key" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "chunk_index" INTEGER NOT NULL DEFAULT 0,
    "embedding" vector(384),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_retrieved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "panel_memory_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "panel_personas" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "spec" JSONB NOT NULL,
    "source_transcript_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "calibrated" BOOLEAN NOT NULL DEFAULT false,
    "origin" TEXT NOT NULL DEFAULT 'interviews',
    "dropped_objections" JSONB,
    "edited_by" TEXT,
    "edited_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "panel_personas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "panel_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'page_walk',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "target" JSONB NOT NULL,
    "target_label" TEXT NOT NULL,
    "persona_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "persona_snapshot" JSONB NOT NULL,
    "step_cap" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "model_kind" TEXT NOT NULL DEFAULT 'live',
    "estimate_credits" INTEGER NOT NULL,
    "cap_credits" INTEGER NOT NULL,
    "spent_credits" INTEGER NOT NULL DEFAULT 0,
    "call_count" INTEGER NOT NULL DEFAULT 0,
    "stop_reason" TEXT,
    "report" JSONB,
    "job_id" TEXT,
    "confirmed_by" TEXT NOT NULL,
    "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "panel_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "panel_steps" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "persona_key" TEXT NOT NULL,
    "persona_name" TEXT NOT NULL,
    "step_index" INTEGER NOT NULL,
    "intent" JSONB,
    "think_aloud" TEXT NOT NULL DEFAULT '',
    "observation" JSONB NOT NULL,
    "signals" JSONB NOT NULL,
    "flags" JSONB NOT NULL DEFAULT '[]',
    "screenshot_ref" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "panel_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "panel_verdicts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "persona_key" TEXT NOT NULL,
    "persona_name" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "verdict" TEXT,
    "withheld_reason" TEXT,
    "confidence" DOUBLE PRECISION,
    "rationale" TEXT NOT NULL DEFAULT '',
    "objections" JSONB NOT NULL DEFAULT '[]',
    "what_would_change_mind" JSONB NOT NULL DEFAULT '[]',
    "behavior_summary" TEXT NOT NULL DEFAULT '',
    "timeline" JSONB NOT NULL,
    "trace_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "panel_verdicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "panel_calibrations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "predicted_rate" DOUBLE PRECISION NOT NULL,
    "predicted_n" INTEGER NOT NULL,
    "actual_conversions" INTEGER NOT NULL,
    "actual_visitors" INTEGER NOT NULL,
    "actual_rate" DOUBLE PRECISION NOT NULL,
    "z" DOUBLE PRECISION NOT NULL,
    "p_value" DOUBLE PRECISION NOT NULL,
    "verdict" TEXT NOT NULL,
    "abs_error" DOUBLE PRECISION NOT NULL,
    "entered_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "panel_calibrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "panel_transcripts_workspace_id_created_at_idx" ON "panel_transcripts"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "panel_memory_nodes_workspace_id_transcript_id_kind_idx" ON "panel_memory_nodes"("workspace_id", "transcript_id", "kind");

-- CreateIndex
CREATE INDEX "panel_memory_nodes_workspace_id_run_id_persona_key_idx" ON "panel_memory_nodes"("workspace_id", "run_id", "persona_key");

-- CreateIndex
CREATE UNIQUE INDEX "panel_memory_nodes_workspace_id_node_key_key" ON "panel_memory_nodes"("workspace_id", "node_key");

-- CreateIndex
CREATE INDEX "panel_personas_workspace_id_status_idx" ON "panel_personas"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "panel_runs_workspace_id_created_at_idx" ON "panel_runs"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "panel_runs_workspace_id_status_idx" ON "panel_runs"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "panel_steps_workspace_id_run_id_idx" ON "panel_steps"("workspace_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "panel_steps_run_id_persona_key_step_index_key" ON "panel_steps"("run_id", "persona_key", "step_index");

-- CreateIndex
CREATE INDEX "panel_verdicts_workspace_id_run_id_idx" ON "panel_verdicts"("workspace_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "panel_verdicts_run_id_persona_key_key" ON "panel_verdicts"("run_id", "persona_key");

-- CreateIndex
CREATE UNIQUE INDEX "panel_calibrations_run_id_key" ON "panel_calibrations"("run_id");

-- CreateIndex
CREATE INDEX "panel_calibrations_workspace_id_created_at_idx" ON "panel_calibrations"("workspace_id", "created_at");

-- AddForeignKey
ALTER TABLE "panel_transcripts" ADD CONSTRAINT "panel_transcripts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_memory_nodes" ADD CONSTRAINT "panel_memory_nodes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_memory_nodes" ADD CONSTRAINT "panel_memory_nodes_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "panel_transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_memory_nodes" ADD CONSTRAINT "panel_memory_nodes_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "panel_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_personas" ADD CONSTRAINT "panel_personas_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_runs" ADD CONSTRAINT "panel_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_steps" ADD CONSTRAINT "panel_steps_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_steps" ADD CONSTRAINT "panel_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "panel_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_verdicts" ADD CONSTRAINT "panel_verdicts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_verdicts" ADD CONSTRAINT "panel_verdicts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "panel_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_calibrations" ADD CONSTRAINT "panel_calibrations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_calibrations" ADD CONSTRAINT "panel_calibrations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "panel_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- RLS: same tenant-isolation pattern as the phase-4a / 18.x migrations.
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['panel_transcripts', 'panel_memory_nodes', 'panel_personas', 'panel_runs', 'panel_steps', 'panel_verdicts', 'panel_calibrations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL ' ||
      'USING (workspace_id = current_setting(''app.workspace_id'', true)) ' ||
      'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;
