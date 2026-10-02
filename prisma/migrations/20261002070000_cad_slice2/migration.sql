-- CAD + Hardware slice 2: AI design assistant — annotations, design change
-- proposals (draft-for-approval), manufacturability runs + flags.
--
-- Hand-authored (migrate dev is broken on this box: the pgserver-bundled PG
-- lacks pgcrypto contrib files for the shadow DB — same as cad_slice1).
-- Applied via psql, then `prisma migrate resolve --applied`.
--
-- Idempotent: IF NOT EXISTS / DO-block guards throughout, so a re-apply is
-- a no-op. Pre-existing schema↔DB drift from earlier slices deliberately
-- NOT touched here.

-- CadModel: change-request state (set ONLY by approving a design proposal,
-- human-only; cleared when a new version is published).
ALTER TABLE "cad_models" ADD COLUMN IF NOT EXISTS "change_requested" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "cad_models" ADD COLUMN IF NOT EXISTS "change_requested_at" TIMESTAMP(3);
ALTER TABLE "cad_models" ADD COLUMN IF NOT EXISTS "change_requested_by" TEXT;
ALTER TABLE "cad_models" ADD COLUMN IF NOT EXISTS "change_requested_proposal_id" TEXT;

-- Annotations: immutable text notes anchored to a model version.
CREATE TABLE IF NOT EXISTS "cad_annotations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "point" JSONB,
    "region" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cad_annotations_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "cad_annotations" DROP CONSTRAINT IF EXISTS "cad_annotations_workspace_id_fkey";
ALTER TABLE "cad_annotations" ADD CONSTRAINT "cad_annotations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cad_annotations" DROP CONSTRAINT IF EXISTS "cad_annotations_model_id_fkey";
ALTER TABLE "cad_annotations" ADD CONSTRAINT "cad_annotations_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "cad_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cad_annotations" DROP CONSTRAINT IF EXISTS "cad_annotations_version_id_fkey";
ALTER TABLE "cad_annotations" ADD CONSTRAINT "cad_annotations_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "cad_model_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "cad_annotations_workspace_id_model_id_idx" ON "cad_annotations"("workspace_id", "model_id");

-- Design proposals: parsed NL edit requests, draft → approved | rejected.
CREATE TABLE IF NOT EXISTS "cad_design_proposals" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "target_version_id" TEXT NOT NULL,
    "requested_text" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "operation" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "target_feature_label" TEXT,
    "target_region" JSONB,
    "rationale" TEXT,
    "parse_confidence" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cad_design_proposals_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "cad_design_proposals" DROP CONSTRAINT IF EXISTS "cad_design_proposals_workspace_id_fkey";
ALTER TABLE "cad_design_proposals" ADD CONSTRAINT "cad_design_proposals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cad_design_proposals" DROP CONSTRAINT IF EXISTS "cad_design_proposals_model_id_fkey";
ALTER TABLE "cad_design_proposals" ADD CONSTRAINT "cad_design_proposals_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "cad_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cad_design_proposals" DROP CONSTRAINT IF EXISTS "cad_design_proposals_target_version_id_fkey";
ALTER TABLE "cad_design_proposals" ADD CONSTRAINT "cad_design_proposals_target_version_id_fkey" FOREIGN KEY ("target_version_id") REFERENCES "cad_model_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "cad_design_proposals_workspace_id_model_id_status_idx" ON "cad_design_proposals"("workspace_id", "model_id", "status");

-- Manufacturability runs: one analysis attempt per version.
CREATE TABLE IF NOT EXISTS "cad_mfg_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "unavailable_reason" TEXT,
    "unit_assumption" TEXT NOT NULL,
    "checks" JSONB NOT NULL,
    "references" JSONB NOT NULL,
    "started_by" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "cad_mfg_runs_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "cad_mfg_runs" DROP CONSTRAINT IF EXISTS "cad_mfg_runs_workspace_id_fkey";
ALTER TABLE "cad_mfg_runs" ADD CONSTRAINT "cad_mfg_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cad_mfg_runs" DROP CONSTRAINT IF EXISTS "cad_mfg_runs_model_id_fkey";
ALTER TABLE "cad_mfg_runs" ADD CONSTRAINT "cad_mfg_runs_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "cad_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cad_mfg_runs" DROP CONSTRAINT IF EXISTS "cad_mfg_runs_version_id_fkey";
ALTER TABLE "cad_mfg_runs" ADD CONSTRAINT "cad_mfg_runs_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "cad_model_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "cad_mfg_runs_workspace_id_model_id_version_id_idx" ON "cad_mfg_runs"("workspace_id", "model_id", "version_id");

-- Manufacturability flags: deterministic findings, dismissible with reason.
CREATE TABLE IF NOT EXISTS "cad_mfg_flags" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "check_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "measurement" JSONB NOT NULL,
    "message" TEXT NOT NULL,
    "dismissed" BOOLEAN NOT NULL DEFAULT false,
    "dismissed_by" TEXT,
    "dismissed_at" TIMESTAMP(3),
    "dismissal_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cad_mfg_flags_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "cad_mfg_flags" DROP CONSTRAINT IF EXISTS "cad_mfg_flags_workspace_id_fkey";
ALTER TABLE "cad_mfg_flags" ADD CONSTRAINT "cad_mfg_flags_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cad_mfg_flags" DROP CONSTRAINT IF EXISTS "cad_mfg_flags_run_id_fkey";
ALTER TABLE "cad_mfg_flags" ADD CONSTRAINT "cad_mfg_flags_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "cad_mfg_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cad_mfg_flags" DROP CONSTRAINT IF EXISTS "cad_mfg_flags_model_id_fkey";
ALTER TABLE "cad_mfg_flags" ADD CONSTRAINT "cad_mfg_flags_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "cad_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cad_mfg_flags" DROP CONSTRAINT IF EXISTS "cad_mfg_flags_version_id_fkey";
ALTER TABLE "cad_mfg_flags" ADD CONSTRAINT "cad_mfg_flags_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "cad_model_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "cad_mfg_flags_workspace_id_model_id_version_id_idx" ON "cad_mfg_flags"("workspace_id", "model_id", "version_id");
