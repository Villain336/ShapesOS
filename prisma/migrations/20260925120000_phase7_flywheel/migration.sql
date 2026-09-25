-- CreateEnum
CREATE TYPE "ReallocationMode" AS ENUM ('a', 'b');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('proposed', 'policy_approved', 'policy_denied', 'human_approved', 'executed', 'rejected');

-- CreateEnum
CREATE TYPE "SraStatus" AS ENUM ('active', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "PolicyDecisionKind" AS ENUM ('allow', 'deny');

-- CreateEnum
CREATE TYPE "CurveType" AS ENUM ('hill', 'power', 'loglog');

-- CreateEnum
CREATE TYPE "BreakerType" AS ENUM ('performance', 'velocity', 'measurement', 'error_rate', 'attribution_regime');

-- CreateEnum
CREATE TYPE "FlywheelAuditKind" AS ENUM ('proposal_created', 'proposal_status', 'policy_decision', 'sra_created', 'sra_revoked', 'sra_expired', 'execution', 'execution_halted', 'breaker_fired', 'breaker_acknowledged', 'run_completed', 'approval_materialized');

-- CreateEnum
CREATE TYPE "RecyclingBriefStatus" AS ENUM ('draft', 'approved', 'regenerating', 'ready');

-- CreateEnum
CREATE TYPE "RecyclingAuditAction" AS ENUM ('brief_created', 'brief_approved', 'brief_rejected', 'rewrite_proposed', 'variant_routed', 'asset_regenerated', 'publish_blocked');

-- CreateEnum
CREATE TYPE "DspKind" AS ENUM ('ttd', 'dv360', 'amazon', 'basis');

-- CreateEnum
CREATE TYPE "DspSeatStatus" AS ENUM ('none', 'pending', 'connected');

-- CreateTable
CREATE TABLE "sra_envelopes" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channels" JSONB NOT NULL,
    "per_shift_cap_cents" INTEGER NOT NULL,
    "daily_aggregate_cap_cents" INTEGER NOT NULL,
    "weekly_aggregate_cap_cents" INTEGER NOT NULL,
    "per_channel_band_pct" DOUBLE PRECISION NOT NULL,
    "exploration_floor_pct" DOUBLE PRECISION NOT NULL,
    "cooldown_hours" INTEGER NOT NULL,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_until" TIMESTAMP(3) NOT NULL,
    "revocation_id" TEXT NOT NULL,
    "status" "SraStatus" NOT NULL DEFAULT 'active',
    "signer_ids" JSONB NOT NULL,
    "signature_hash" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,

    CONSTRAINT "sra_envelopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reallocation_proposals" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "mode" "ReallocationMode" NOT NULL,
    "sra_id" TEXT,
    "source_channel" TEXT NOT NULL,
    "dest_channel" TEXT NOT NULL,
    "source_campaign_ref" TEXT NOT NULL,
    "dest_campaign_ref" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "marginal_roas_delta" DOUBLE PRECISION NOT NULL,
    "decision_record" JSONB NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'proposed',
    "human_approval_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reallocation_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_decisions" (
    "id" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "decision" "PolicyDecisionKind" NOT NULL,
    "reasons" JSONB NOT NULL,
    "sra_id" TEXT,
    "revocation_checked_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "policy_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marginal_curves" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "curve_type" "CurveType" NOT NULL,
    "params" JSONB NOT NULL,
    "adstock" JSONB NOT NULL,
    "seasonality" JSONB NOT NULL,
    "r_squared" DOUBLE PRECISION NOT NULL,
    "data_window" TEXT NOT NULL,
    "iroas_calibration_factor" DOUBLE PRECISION,
    "fitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "model_version" TEXT NOT NULL,

    CONSTRAINT "marginal_curves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_floors" (
    "workspace_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "learning_viable_min_cents_day" INTEGER NOT NULL,
    "stabilization_hours" INTEGER NOT NULL,

    CONSTRAINT "channel_floors_pkey" PRIMARY KEY ("workspace_id","channel")
);

-- CreateTable
CREATE TABLE "reallocation_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mode" "ReallocationMode" NOT NULL,
    "proposals_count" INTEGER NOT NULL,
    "executed_count" INTEGER NOT NULL,
    "denied_count" INTEGER NOT NULL,
    "frozen" BOOLEAN NOT NULL DEFAULT false,
    "data_health_snapshot" JSONB NOT NULL,

    CONSTRAINT "reallocation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "breaker_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "breaker_type" "BreakerType" NOT NULL,
    "scope" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "fired_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_by" TEXT,
    "acknowledged_at" TIMESTAMP(3),
    "cooldown_until" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "breaker_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flywheel_audit_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "kind" "FlywheelAuditKind" NOT NULL,
    "actor" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "prev_hash" TEXT NOT NULL,
    "event_hash" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flywheel_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recycling_briefs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "source_asset_id" TEXT NOT NULL,
    "source_channel" TEXT NOT NULL,
    "trigger_signal_json" JSONB NOT NULL,
    "target_channels" TEXT[],
    "variant_specs_json" JSONB NOT NULL,
    "creative_hash_lineage_json" JSONB NOT NULL DEFAULT '[]',
    "status" "RecyclingBriefStatus" NOT NULL DEFAULT 'draft',
    "approval_id" TEXT,
    "studio_routing_json" JSONB NOT NULL DEFAULT '[]',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recycling_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recycling_brief_events" (
    "id" TEXT NOT NULL,
    "brief_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" "RecyclingAuditAction" NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "prev_hash" TEXT NOT NULL,
    "event_hash" TEXT NOT NULL,
    "detail" JSONB,

    CONSTRAINT "recycling_brief_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiment_ideas" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source_signal" TEXT,
    "pie_ice_score" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "experiment_ideas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "pie_ice_score" DOUBLE PRECISION NOT NULL,
    "channel" TEXT NOT NULL,
    "variants_json" JSONB NOT NULL,
    "audience" TEXT NOT NULL,
    "primary_metric" TEXT NOT NULL,
    "metric_type" TEXT NOT NULL DEFAULT 'binomial',
    "guardrail_metrics_json" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "profit_guardrail_json" JSONB,
    "traffic_floor_note" TEXT,
    "min_runtime_days" INTEGER NOT NULL DEFAULT 7,
    "stated_mde" DOUBLE PRECISION NOT NULL,
    "verdict" TEXT,
    "baseline_rate" DOUBLE PRECISION NOT NULL,
    "monthly_traffic" DOUBLE PRECISION NOT NULL,
    "launched_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "qa_report_json" JSONB,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "experiments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiment_results" (
    "id" TEXT NOT NULL,
    "experiment_id" TEXT NOT NULL,
    "stats_json" JSONB NOT NULL,
    "srm_json" JSONB NOT NULL,
    "guardrail_checks_json" JSONB NOT NULL DEFAULT '[]',
    "verdict" TEXT,
    "archived_to_memory" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "experiment_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ctv_campaigns" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'concierge',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approval_object_id" TEXT,
    "budget_cents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "flight_start" TIMESTAMP(3),
    "flight_end" TIMESTAMP(3),
    "targeting_json" JSONB,
    "creative_ids" TEXT[],
    "creative_hashes" TEXT[],
    "vibe_advertiser_id" TEXT,
    "vibe_campaign_id" TEXT,
    "vibe_test_mode" BOOLEAN NOT NULL DEFAULT true,
    "vibe_config_ref" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ctv_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ctv_creative_validations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "creative_id" TEXT NOT NULL,
    "creative_sha256" TEXT,
    "ffprobe_json" JSONB NOT NULL,
    "pass" BOOLEAN NOT NULL,
    "checks" JSONB NOT NULL,
    "duration_seconds" DOUBLE PRECISION,
    "publisher" TEXT,
    "publisher_rules_version" TEXT NOT NULL,
    "validated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ctv_creative_validations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ctv_spots" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "placement_label" TEXT NOT NULL,
    "show_genre" TEXT,
    "daypart" TEXT,
    "demo" TEXT,
    "creative_id" TEXT,
    "qr_id" TEXT,
    "purl_id" TEXT,
    "qr_svg" TEXT,
    "flight_from" TIMESTAMP(3),
    "flight_to" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ctv_spots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ctv_ios" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "io_payload" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "placed_by" TEXT,
    "placed_at" TIMESTAMP(3),
    "vendor_confirmation" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ctv_ios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ctv_pixels" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "pixel_url" TEXT NOT NULL,
    "pixel_token" TEXT NOT NULL,
    "view_through_window_days" INTEGER NOT NULL DEFAULT 14,
    "impressions_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ctv_pixels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsp_adapters" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "dsp" "DspKind" NOT NULL,
    "seat_status" "DspSeatStatus" NOT NULL DEFAULT 'none',
    "config_ref" TEXT,
    "connected_at" TIMESTAMP(3),
    "connected_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dsp_adapters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_schedules" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "dsp" "DspKind" NOT NULL,
    "version" INTEGER NOT NULL,
    "fee_lines_json" JSONB NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "margin_ledger" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "dsp_adapter_id" TEXT NOT NULL,
    "dsp" "DspKind" NOT NULL,
    "client_billed_cents" INTEGER NOT NULL,
    "platform_fees_cents" INTEGER NOT NULL,
    "passthrough_cents" INTEGER NOT NULL,
    "marketr_margin_cents" INTEGER NOT NULL,
    "fee_schedule_version" INTEGER NOT NULL,
    "note" TEXT,
    "posted_by" TEXT NOT NULL,
    "posted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "margin_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "launch_checklist" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "evidence_url" TEXT,
    "note" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "launch_checklist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sra_envelopes_revocation_id_key" ON "sra_envelopes"("revocation_id");

-- CreateIndex
CREATE INDEX "sra_envelopes_workspace_id_status_idx" ON "sra_envelopes"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "reallocation_proposals_workspace_id_status_idx" ON "reallocation_proposals"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "reallocation_proposals_workspace_id_sra_id_idx" ON "reallocation_proposals"("workspace_id", "sra_id");

-- CreateIndex
CREATE INDEX "policy_decisions_proposal_id_idx" ON "policy_decisions"("proposal_id");

-- CreateIndex
CREATE INDEX "marginal_curves_workspace_id_channel_idx" ON "marginal_curves"("workspace_id", "channel");

-- CreateIndex
CREATE INDEX "reallocation_runs_workspace_id_run_at_idx" ON "reallocation_runs"("workspace_id", "run_at");

-- CreateIndex
CREATE INDEX "breaker_events_workspace_id_breaker_type_idx" ON "breaker_events"("workspace_id", "breaker_type");

-- CreateIndex
CREATE INDEX "breaker_events_workspace_id_scope_idx" ON "breaker_events"("workspace_id", "scope");

-- CreateIndex
CREATE INDEX "flywheel_audit_events_workspace_id_ts_idx" ON "flywheel_audit_events"("workspace_id", "ts");

-- CreateIndex
CREATE INDEX "flywheel_audit_events_workspace_id_correlation_id_idx" ON "flywheel_audit_events"("workspace_id", "correlation_id");

-- CreateIndex
CREATE INDEX "recycling_briefs_workspace_id_status_idx" ON "recycling_briefs"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "recycling_briefs_workspace_id_source_asset_id_idx" ON "recycling_briefs"("workspace_id", "source_asset_id");

-- CreateIndex
CREATE INDEX "recycling_brief_events_brief_id_ts_idx" ON "recycling_brief_events"("brief_id", "ts");

-- CreateIndex
CREATE INDEX "recycling_brief_events_workspace_id_ts_idx" ON "recycling_brief_events"("workspace_id", "ts");

-- CreateIndex
CREATE INDEX "experiment_ideas_workspace_id_status_idx" ON "experiment_ideas"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "experiments_workspace_id_status_idx" ON "experiments"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "experiments_workspace_id_channel_idx" ON "experiments"("workspace_id", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "experiment_results_experiment_id_key" ON "experiment_results"("experiment_id");

-- CreateIndex
CREATE INDEX "ctv_campaigns_workspace_id_status_idx" ON "ctv_campaigns"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "ctv_creative_validations_workspace_id_creative_id_idx" ON "ctv_creative_validations"("workspace_id", "creative_id");

-- CreateIndex
CREATE INDEX "ctv_spots_workspace_id_campaign_id_idx" ON "ctv_spots"("workspace_id", "campaign_id");

-- CreateIndex
CREATE INDEX "ctv_ios_workspace_id_campaign_id_idx" ON "ctv_ios"("workspace_id", "campaign_id");

-- CreateIndex
CREATE INDEX "ctv_pixels_pixel_token_idx" ON "ctv_pixels"("pixel_token");

-- CreateIndex
CREATE INDEX "dsp_adapters_workspace_id_idx" ON "dsp_adapters"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "dsp_adapters_workspace_id_dsp_key" ON "dsp_adapters"("workspace_id", "dsp");

-- CreateIndex
CREATE INDEX "fee_schedules_workspace_id_dsp_effective_from_idx" ON "fee_schedules"("workspace_id", "dsp", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "fee_schedules_workspace_id_dsp_version_key" ON "fee_schedules"("workspace_id", "dsp", "version");

-- CreateIndex
CREATE INDEX "margin_ledger_workspace_id_period_idx" ON "margin_ledger"("workspace_id", "period");

-- CreateIndex
CREATE INDEX "margin_ledger_workspace_id_dsp_adapter_id_idx" ON "margin_ledger"("workspace_id", "dsp_adapter_id");

-- CreateIndex
CREATE INDEX "launch_checklist_workspace_id_category_idx" ON "launch_checklist"("workspace_id", "category");

-- CreateIndex
CREATE INDEX "launch_checklist_workspace_id_status_idx" ON "launch_checklist"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "launch_checklist_workspace_id_key_key" ON "launch_checklist"("workspace_id", "key");

-- AddForeignKey
ALTER TABLE "reallocation_proposals" ADD CONSTRAINT "reallocation_proposals_sra_id_fkey" FOREIGN KEY ("sra_id") REFERENCES "sra_envelopes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "reallocation_proposals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recycling_brief_events" ADD CONSTRAINT "recycling_brief_events_brief_id_fkey" FOREIGN KEY ("brief_id") REFERENCES "recycling_briefs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiment_results" ADD CONSTRAINT "experiment_results_experiment_id_fkey" FOREIGN KEY ("experiment_id") REFERENCES "experiments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ctv_campaigns" ADD CONSTRAINT "ctv_campaigns_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ctv_creative_validations" ADD CONSTRAINT "ctv_creative_validations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ctv_creative_validations" ADD CONSTRAINT "ctv_creative_validations_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ctv_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ctv_spots" ADD CONSTRAINT "ctv_spots_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ctv_spots" ADD CONSTRAINT "ctv_spots_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ctv_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ctv_ios" ADD CONSTRAINT "ctv_ios_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ctv_ios" ADD CONSTRAINT "ctv_ios_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ctv_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ctv_pixels" ADD CONSTRAINT "ctv_pixels_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ctv_pixels" ADD CONSTRAINT "ctv_pixels_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ctv_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "launch_checklist" ADD CONSTRAINT "launch_checklist_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

