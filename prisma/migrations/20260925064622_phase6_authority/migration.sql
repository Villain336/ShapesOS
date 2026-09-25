-- CreateEnum
CREATE TYPE "AuthorityApprovalType" AS ENUM ('outreach_send', 'depth3_activation', 'pr_send', 'listing_edit', 'review_reply_post', 'aeo_content_fix');

-- CreateEnum
CREATE TYPE "AuthorityApprovalStatus" AS ENUM ('draft', 'pending', 'approved', 'approval_rejected', 'revoked', 'expired', 'executed');

-- CreateEnum
CREATE TYPE "OutreachCampaignStatus" AS ENUM ('draft', 'checklist_pending', 'active', 'paused', 'completed', 'archived');

-- CreateEnum
CREATE TYPE "SendingDomainStatus" AS ENUM ('pending', 'warming', 'ready', 'blocked');

-- CreateEnum
CREATE TYPE "ProspectStatus" AS ENUM ('new', 'qualified', 'contacted', 'replied', 'placed', 'bounced', 'suppressed', 'declined');

-- CreateEnum
CREATE TYPE "SequenceStatus" AS ENUM ('draft', 'scheduled', 'sending', 'paused', 'completed', 'stopped', 'expired');

-- CreateEnum
CREATE TYPE "OutreachEventType" AS ENUM ('sent', 'opened', 'clicked', 'replied', 'bounced', 'unsubscribed', 'placement_verified');

-- CreateEnum
CREATE TYPE "SuppressionKind" AS ENUM ('global', 'campaign');

-- CreateEnum
CREATE TYPE "PrSource" AS ENUM ('haro', 'connectively', 'qwoted', 'sos', 'hab2bw', 'journo_request');

-- CreateEnum
CREATE TYPE "PrOpportunityStatus" AS ENUM ('new', 'matched', 'drafting', 'submitted', 'placed', 'declined', 'expired');

-- CreateEnum
CREATE TYPE "PrDraftStatus" AS ENUM ('draft', 'human_approved', 'sent');

-- CreateEnum
CREATE TYPE "ListingTier" AS ENUM ('api_synced', 'aggregator', 'manual', 'guided_claim');

-- CreateEnum
CREATE TYPE "ChannelStatus" AS ENUM ('connected', 'syncing', 'error', 'disconnected');

-- CreateEnum
CREATE TYPE "CitationBriefStatus" AS ENUM ('draft', 'in_progress', 'verified', 'archived');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('queued', 'executed', 'failed', 'skipped_rate_limited');

-- CreateEnum
CREATE TYPE "ReviewSource" AS ENUM ('gbp', 'apple', 'bing', 'yelp', 'facebook');

-- CreateEnum
CREATE TYPE "ReviewQueueStatus" AS ENUM ('pending', 'approved', 'posted', 'rejected', 'escalated');

-- CreateEnum
CREATE TYPE "ReviewReplyState" AS ENUM ('none', 'pending_mod', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "AeoEngine" AS ENUM ('openai', 'anthropic', 'gemini', 'perplexity');

-- CreateEnum
CREATE TYPE "AeoRunStatus" AS ENUM ('queued', 'running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "AeoActionKind" AS ENUM ('owned_fix', 'third_party_plan');

-- CreateEnum
CREATE TYPE "AeoActionStatus" AS ENUM ('proposed', 'approved', 'applied', 'done', 'dismissed');

-- CreateEnum
CREATE TYPE "IntelligenceReportStatus" AS ENUM ('draft', 'ready', 'archived');

-- CreateTable
CREATE TABLE "authority_approvals" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "type" "AuthorityApprovalType" NOT NULL,
    "status" "AuthorityApprovalStatus" NOT NULL DEFAULT 'draft',
    "binding_json" JSONB NOT NULL,
    "binding_hash" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "approvers_json" JSONB NOT NULL DEFAULT '[]',
    "two_person_required" BOOLEAN NOT NULL DEFAULT false,
    "approval_receipt" TEXT,
    "decided_at" TIMESTAMP(3),
    "executed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authority_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authority_approval_events" (
    "id" TEXT NOT NULL,
    "approval_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "prev_hash" TEXT NOT NULL,
    "event_hash" TEXT NOT NULL,
    "detail" JSONB,

    CONSTRAINT "authority_approval_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authority_audit_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "prev_hash" TEXT NOT NULL,
    "event_hash" TEXT NOT NULL,
    "detail" JSONB,

    CONSTRAINT "authority_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_campaigns" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 1,
    "status" "OutreachCampaignStatus" NOT NULL DEFAULT 'draft',
    "sending_domain_id" TEXT,
    "daily_cap" INTEGER NOT NULL DEFAULT 30,
    "warmup_verified_at" TIMESTAMP(3),
    "auth_status_json" JSONB NOT NULL DEFAULT '{}',
    "approval_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreach_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sending_domains" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "spf_ok" BOOLEAN NOT NULL DEFAULT false,
    "dkim_ok" BOOLEAN NOT NULL DEFAULT false,
    "dmarc_policy" TEXT,
    "warmup_started_at" TIMESTAMP(3),
    "warmup_stage" INTEGER NOT NULL DEFAULT 0,
    "tracking_cname_ok" BOOLEAN NOT NULL DEFAULT false,
    "status" "SendingDomainStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sending_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_prospects" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "contact_name" TEXT,
    "email" TEXT,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "quality_score" INTEGER NOT NULL DEFAULT 0,
    "relevance_score" INTEGER NOT NULL DEFAULT 0,
    "status" "ProspectStatus" NOT NULL DEFAULT 'new',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreach_prospects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_sequences" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "prospect_id" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,
    "steps_json" JSONB NOT NULL DEFAULT '[]',
    "status" "SequenceStatus" NOT NULL DEFAULT 'draft',
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "reply_id" TEXT,
    "stopped_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreach_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "sequence_id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "event" "OutreachEventType" NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "detail" JSONB,

    CONSTRAINT "outreach_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppression_lists" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "kind" "SuppressionKind" NOT NULL,
    "campaign_id" TEXT,
    "entries_json" JSONB NOT NULL DEFAULT '[]',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppression_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pr_opportunities" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "source" "PrSource" NOT NULL,
    "journalist" TEXT NOT NULL,
    "outlet" TEXT NOT NULL,
    "query_text" TEXT NOT NULL,
    "deadline" TIMESTAMP(3),
    "match_score" INTEGER NOT NULL DEFAULT 0,
    "expertise_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "PrOpportunityStatus" NOT NULL DEFAULT 'new',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pr_drafts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "opportunity_id" TEXT NOT NULL,
    "research_brief_json" JSONB NOT NULL DEFAULT '{}',
    "quote_skeleton" TEXT NOT NULL DEFAULT '',
    "checklist_json" JSONB NOT NULL DEFAULT '{}',
    "de_ai_passed" BOOLEAN NOT NULL DEFAULT false,
    "status" "PrDraftStatus" NOT NULL DEFAULT 'draft',
    "approval_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pr_relationships" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "journalist" TEXT NOT NULL,
    "outlet" TEXT NOT NULL,
    "history_json" JSONB NOT NULL DEFAULT '[]',
    "declination_reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reengagement_eligible_at" TIMESTAMP(3),
    "follow_up_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pr_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pr_placements" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "opportunity_id" TEXT,
    "url" TEXT NOT NULL,
    "outlet" TEXT NOT NULL,
    "publish_date" TIMESTAMP(3),
    "visibility_impact_json" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "pr_placements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_channels" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "tier" "ListingTier" NOT NULL,
    "status" "ChannelStatus" NOT NULL DEFAULT 'disconnected',
    "last_sync_at" TIMESTAMP(3),
    "last_verified_at" TIMESTAMP(3),
    "sync_errors_json" JSONB NOT NULL DEFAULT '[]',
    "config_json" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "listing_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_profiles" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "location_ref" TEXT NOT NULL,
    "nap_json" JSONB NOT NULL DEFAULT '{}',
    "hours_json" JSONB NOT NULL DEFAULT '{}',
    "attributes_json" JSONB NOT NULL DEFAULT '{}',
    "photos_json" JSONB NOT NULL DEFAULT '[]',
    "verification_status" TEXT NOT NULL DEFAULT 'unverified',

    CONSTRAINT "listing_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_sync_jobs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "approval_id" TEXT,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'queued',
    "scheduled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executed_at" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "listing_sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "citation_briefs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "competitor_gap_json" JSONB NOT NULL DEFAULT '{}',
    "directories_json" JSONB NOT NULL DEFAULT '[]',
    "checklist_status" "CitationBriefStatus" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "citation_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_queue" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "location_ref" TEXT NOT NULL,
    "review_id" TEXT NOT NULL,
    "source" "ReviewSource" NOT NULL,
    "rating" INTEGER NOT NULL,
    "sentiment" "ReviewSentiment" NOT NULL,
    "review_text" TEXT,
    "reviewer_name" TEXT,
    "draft_reply" TEXT,
    "guardrail_flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ReviewQueueStatus" NOT NULL DEFAULT 'pending',
    "reply_state" "ReviewReplyState" NOT NULL DEFAULT 'none',
    "posted_at" TIMESTAMP(3),
    "rejection_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_velocity" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "location_ref" TEXT NOT NULL,
    "requests_sent" INTEGER NOT NULL DEFAULT 0,
    "reviews_received" INTEGER NOT NULL DEFAULT 0,
    "velocity_7d" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "velocity_30d" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "funnel_json" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_velocity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aeo_prompt_sets" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "prompts_json" JSONB NOT NULL,
    "created_by" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aeo_prompt_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aeo_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "prompt_set_id" TEXT NOT NULL,
    "prompt_set_version" INTEGER NOT NULL,
    "engine" "AeoEngine" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "reps" INTEGER NOT NULL DEFAULT 3,
    "status" "AeoRunStatus" NOT NULL DEFAULT 'queued',
    "cost_estimate_cents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "aeo_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aeo_mentions" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "prompt_idx" INTEGER NOT NULL,
    "rep" INTEGER NOT NULL,
    "mentioned" BOOLEAN NOT NULL,
    "position" INTEGER,
    "sentiment" TEXT,
    "competitors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cited_sources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "judge_model" TEXT NOT NULL,
    "judge_confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "aeo_mentions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aeo_source_impact" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "engine" "AeoEngine" NOT NULL,
    "domain" TEXT NOT NULL,
    "citation_frequency" INTEGER NOT NULL DEFAULT 0,
    "citation_efficiency" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cooccurrence_lift" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aeo_source_impact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aeo_actions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "kind" "AeoActionKind" NOT NULL,
    "source_ref" TEXT NOT NULL,
    "geo16_pillars" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fix_proposal_json" JSONB NOT NULL DEFAULT '{}',
    "action_plan_json" JSONB NOT NULL DEFAULT '{}',
    "expected_lift" DOUBLE PRECISION,
    "status" "AeoActionStatus" NOT NULL DEFAULT 'proposed',
    "approval_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aeo_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intelligence_reports" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "audit_completeness_json" JSONB NOT NULL DEFAULT '{}',
    "audits_json" JSONB NOT NULL DEFAULT '{}',
    "opportunities_json" JSONB NOT NULL DEFAULT '[]',
    "plan_90d_json" JSONB NOT NULL DEFAULT '{}',
    "pdf_url" TEXT,
    "status" "IntelligenceReportStatus" NOT NULL DEFAULT 'draft',
    "generated_at" TIMESTAMP(3),
    "generated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intelligence_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "authority_approvals_workspace_id_type_status_idx" ON "authority_approvals"("workspace_id", "type", "status");

-- CreateIndex
CREATE INDEX "authority_approval_events_approval_id_ts_idx" ON "authority_approval_events"("approval_id", "ts");

-- CreateIndex
CREATE INDEX "authority_audit_events_workspace_id_ts_idx" ON "authority_audit_events"("workspace_id", "ts");

-- CreateIndex
CREATE INDEX "outreach_campaigns_workspace_id_status_idx" ON "outreach_campaigns"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sending_domains_workspace_id_domain_key" ON "sending_domains"("workspace_id", "domain");

-- CreateIndex
CREATE INDEX "outreach_prospects_workspace_id_campaign_id_status_idx" ON "outreach_prospects"("workspace_id", "campaign_id", "status");

-- CreateIndex
CREATE INDEX "outreach_sequences_workspace_id_campaign_id_status_idx" ON "outreach_sequences"("workspace_id", "campaign_id", "status");

-- CreateIndex
CREATE INDEX "outreach_events_sequence_id_ts_idx" ON "outreach_events"("sequence_id", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "suppression_lists_workspace_id_kind_campaign_id_key" ON "suppression_lists"("workspace_id", "kind", "campaign_id");

-- CreateIndex
CREATE INDEX "pr_opportunities_workspace_id_status_deadline_idx" ON "pr_opportunities"("workspace_id", "status", "deadline");

-- CreateIndex
CREATE INDEX "pr_drafts_workspace_id_opportunity_id_idx" ON "pr_drafts"("workspace_id", "opportunity_id");

-- CreateIndex
CREATE UNIQUE INDEX "pr_relationships_workspace_id_journalist_outlet_key" ON "pr_relationships"("workspace_id", "journalist", "outlet");

-- CreateIndex
CREATE INDEX "pr_placements_workspace_id_publish_date_idx" ON "pr_placements"("workspace_id", "publish_date");

-- CreateIndex
CREATE UNIQUE INDEX "listing_channels_workspace_id_channel_key" ON "listing_channels"("workspace_id", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "listing_profiles_workspace_id_channel_location_ref_key" ON "listing_profiles"("workspace_id", "channel", "location_ref");

-- CreateIndex
CREATE INDEX "listing_sync_jobs_workspace_id_channel_status_scheduled_at_idx" ON "listing_sync_jobs"("workspace_id", "channel", "status", "scheduled_at");

-- CreateIndex
CREATE INDEX "citation_briefs_workspace_id_idx" ON "citation_briefs"("workspace_id");

-- CreateIndex
CREATE INDEX "review_queue_workspace_id_status_sentiment_idx" ON "review_queue"("workspace_id", "status", "sentiment");

-- CreateIndex
CREATE UNIQUE INDEX "review_queue_workspace_id_source_review_id_key" ON "review_queue"("workspace_id", "source", "review_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_velocity_workspace_id_location_ref_key" ON "review_velocity"("workspace_id", "location_ref");

-- CreateIndex
CREATE UNIQUE INDEX "aeo_prompt_sets_workspace_id_version_key" ON "aeo_prompt_sets"("workspace_id", "version");

-- CreateIndex
CREATE INDEX "aeo_runs_workspace_id_engine_status_idx" ON "aeo_runs"("workspace_id", "engine", "status");

-- CreateIndex
CREATE UNIQUE INDEX "aeo_mentions_run_id_prompt_idx_rep_key" ON "aeo_mentions"("run_id", "prompt_idx", "rep");

-- CreateIndex
CREATE UNIQUE INDEX "aeo_source_impact_workspace_id_engine_domain_key" ON "aeo_source_impact"("workspace_id", "engine", "domain");

-- CreateIndex
CREATE INDEX "aeo_actions_workspace_id_kind_status_idx" ON "aeo_actions"("workspace_id", "kind", "status");

-- CreateIndex
CREATE INDEX "intelligence_reports_workspace_id_status_idx" ON "intelligence_reports"("workspace_id", "status");

-- AddForeignKey
ALTER TABLE "authority_approvals" ADD CONSTRAINT "authority_approvals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authority_approval_events" ADD CONSTRAINT "authority_approval_events_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "authority_approvals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authority_audit_events" ADD CONSTRAINT "authority_audit_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_campaigns" ADD CONSTRAINT "outreach_campaigns_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_campaigns" ADD CONSTRAINT "outreach_campaigns_sending_domain_id_fkey" FOREIGN KEY ("sending_domain_id") REFERENCES "sending_domains"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sending_domains" ADD CONSTRAINT "sending_domains_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_prospects" ADD CONSTRAINT "outreach_prospects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_prospects" ADD CONSTRAINT "outreach_prospects_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "outreach_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_sequences" ADD CONSTRAINT "outreach_sequences_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_sequences" ADD CONSTRAINT "outreach_sequences_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "outreach_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "outreach_sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppression_lists" ADD CONSTRAINT "suppression_lists_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_opportunities" ADD CONSTRAINT "pr_opportunities_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_drafts" ADD CONSTRAINT "pr_drafts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_drafts" ADD CONSTRAINT "pr_drafts_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "pr_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_relationships" ADD CONSTRAINT "pr_relationships_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_placements" ADD CONSTRAINT "pr_placements_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_placements" ADD CONSTRAINT "pr_placements_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "pr_opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_channels" ADD CONSTRAINT "listing_channels_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_profiles" ADD CONSTRAINT "listing_profiles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_sync_jobs" ADD CONSTRAINT "listing_sync_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citation_briefs" ADD CONSTRAINT "citation_briefs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_queue" ADD CONSTRAINT "review_queue_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_velocity" ADD CONSTRAINT "review_velocity_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aeo_prompt_sets" ADD CONSTRAINT "aeo_prompt_sets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aeo_runs" ADD CONSTRAINT "aeo_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aeo_runs" ADD CONSTRAINT "aeo_runs_prompt_set_id_fkey" FOREIGN KEY ("prompt_set_id") REFERENCES "aeo_prompt_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aeo_mentions" ADD CONSTRAINT "aeo_mentions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "aeo_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aeo_source_impact" ADD CONSTRAINT "aeo_source_impact_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aeo_actions" ADD CONSTRAINT "aeo_actions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence_reports" ADD CONSTRAINT "intelligence_reports_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
