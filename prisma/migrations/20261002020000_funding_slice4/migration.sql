-- CreateEnum
CREATE TYPE "FundingChecklistItemKey" AS ENUM ('incorporation', 'ein', 'cap_table', 'safe_template', 'pitch_deck', 'financials', 'data_room_links');

-- CreateEnum
CREATE TYPE "FundingChecklistItemStatus" AS ENUM ('todo', 'doing', 'done', 'waived');

-- CreateEnum
CREATE TYPE "FundingStakeholderType" AS ENUM ('founder', 'investor', 'employee', 'advisor');

-- AlterEnum
BEGIN;
CREATE TYPE "FileChangeAction_new" AS ENUM ('save', 'ai_proposal', 'ai_applied', 'deploy', 'fix_applied', 'fix_reverted', 'credential_created', 'credential_deleted', 'member_added', 'member_role_changed', 'member_removed', 'report_generated', 'report_scheduled', 'alert_channel_created', 'alert_channel_updated', 'alert_channel_deleted', 'alert_rule_created', 'alert_rule_updated', 'alert_rule_deleted', 'alert_sent', 'alert_failed', 'ai_visibility_snapshot', 'decay_finding_created', 'decay_finding_resolved', 'radar_event_detected', 'visibility_score_computed', 'backlink_pull', 'internal_link_suggestion_created', 'internal_link_suggestion_applied', 'internal_link_suggestion_dismissed', 'local_grid_run', 'local_competitor_snapshot', 'reviews_ingested', 'programmatic_template_created', 'programmatic_template_updated', 'programmatic_template_deleted', 'programmatic_dataset_uploaded', 'programmatic_dataset_deleted', 'programmatic_pages_generated', 'programmatic_page_approved', 'programmatic_page_published', 'programmatic_page_discarded', 'programmatic_page_pushed', 'autopilot_rule_created', 'autopilot_rule_updated', 'autopilot_rule_deleted', 'autopilot_run_started', 'autopilot_run_finished', 'autopilot_item_generated', 'autopilot_item_approved', 'autopilot_item_rejected', 'autopilot_item_published', 'autopilot_item_edited', 'autopilot_killed', 'autopilot_unkilled', 'newsletter_template_created', 'newsletter_template_updated', 'newsletter_template_deleted', 'newsletter_list_created', 'newsletter_list_deleted', 'newsletter_subscribers_imported', 'newsletter_subscriber_unsubscribed', 'newsletter_domain_added', 'newsletter_domain_verified', 'newsletter_test_sent', 'newsletter_broadcast_created', 'newsletter_broadcast_scheduled', 'newsletter_broadcast_sent', 'newsletter_broadcast_failed', 'newsletter_broadcast_cancelled', 'newsletter_resend_key_updated', 'social_buffer_key_updated', 'social_buffer_key_revoked', 'social_channels_synced', 'social_channel_enabled', 'social_channel_disabled', 'social_post_created', 'social_post_updated', 'social_post_scheduled', 'social_post_sent', 'social_post_failed', 'social_post_cancelled', 'social_post_deleted', 'social_analytics_synced', 'ad_campaign_created', 'ad_campaign_updated', 'ad_campaign_deleted', 'ad_higgsfield_key_updated', 'ad_higgsfield_key_revoked', 'ad_generation_started', 'ad_generation_completed', 'ad_generation_failed', 'ad_creative_approved', 'ad_creative_rejected', 'ad_creative_regenerated', 'ad_sent_to_social', 'studio_asset_created', 'studio_asset_deleted', 'studio_porkbun_keys_updated', 'studio_registrant_saved', 'studio_domain_purchased', 'studio_domain_purchase_failed', 'studio_domain_removed', 'report_send_drafted', 'report_send_approved', 'report_send_denied', 'report_send_edited', 'report_send_flagged', 'report_send_rendered', 'report_send_failed', 'auth_login_failed', 'auth_login_succeeded', 'member_invite_accepted', 'skill_installed', 'skill_enabled', 'skill_disabled', 'skill_uninstalled', 'connector_connected', 'connector_disconnected', 'connector_reauth', 'connector_health_checked', 'connector_health_alert', 'mcp_connector_added', 'mcp_connector_removed', 'data_source_bound', 'data_source_unbound', 'file_attached', 'file_removed', 'file_rejected', 'settings_workspace_updated', 'settings_project_updated', 'permission_grant_created', 'permission_grant_removed', 'connector_tool_denied', 'schedule_created', 'schedule_updated', 'schedule_paused', 'schedule_resumed', 'schedule_deleted', 'scheduler_run_proposed', 'scheduler_run_approved', 'scheduler_run_rejected', 'scheduler_run_started', 'scheduler_run_reported', 'scheduler_run_finished', 'scheduler_run_failed', 'scheduler_run_missed', 'scheduler_cycle_blocked', 'scheduler_metering_blocked', 'scheduler_metering_failed', 'scheduler_run_blocked_cap', 'spend_cap_updated', 'event_fired', 'subagent_run_started', 'subagent_run_finished', 'mcp_tool_called', 'mcp_tool_denied', 'mcp_key_created', 'mcp_key_revoked', 'mcp_oauth_authorized', 'mcp_oauth_revoked', 'mcp_rpc', 'graph_fact_appended', 'graph_merge_decided', 'graph_connector_changed', 'campaign_created', 'campaign_updated', 'campaign_archived', 'campaign_link_attached', 'campaign_link_detached', 'link_proposal_resolved');
ALTER TABLE "file_change_log" ALTER COLUMN "action" TYPE "FileChangeAction_new" USING ("action"::text::"FileChangeAction_new");
ALTER TYPE "FileChangeAction" RENAME TO "FileChangeAction_old";
ALTER TYPE "FileChangeAction_new" RENAME TO "FileChangeAction";
DROP TYPE "public"."FileChangeAction_old";
COMMIT;

-- CreateTable
CREATE TABLE "funding_round_checklist_items" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "key" "FundingChecklistItemKey" NOT NULL,
    "status" "FundingChecklistItemStatus" NOT NULL DEFAULT 'todo',
    "evidence" JSONB DEFAULT '{}',
    "notes" TEXT,
    "completed_at" TIMESTAMP(3),
    "completed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "funding_round_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_cap_table_stakeholders" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "FundingStakeholderType" NOT NULL,
    "shares" BIGINT NOT NULL,
    "share_class" TEXT,
    "vesting_summary" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "funding_cap_table_stakeholders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_deck_reviews" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "doc_id" TEXT,
    "doc_version_id" TEXT,
    "input_hash" TEXT NOT NULL,
    "overall_score" INTEGER NOT NULL,
    "results" JSONB NOT NULL,
    "narrative" TEXT NOT NULL,
    "deck_text_provided" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funding_deck_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "funding_round_checklist_items_workspace_id_round_id_idx" ON "funding_round_checklist_items"("workspace_id", "round_id");

-- CreateIndex
CREATE UNIQUE INDEX "funding_round_checklist_items_round_id_key_key" ON "funding_round_checklist_items"("round_id", "key");

-- CreateIndex
CREATE INDEX "funding_cap_table_stakeholders_workspace_id_round_id_idx" ON "funding_cap_table_stakeholders"("workspace_id", "round_id");

-- CreateIndex
CREATE INDEX "funding_deck_reviews_workspace_id_round_id_created_at_idx" ON "funding_deck_reviews"("workspace_id", "round_id", "created_at");

-- AddForeignKey
ALTER TABLE "funding_round_checklist_items" ADD CONSTRAINT "funding_round_checklist_items_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_round_checklist_items" ADD CONSTRAINT "funding_round_checklist_items_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "funding_rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_cap_table_stakeholders" ADD CONSTRAINT "funding_cap_table_stakeholders_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_cap_table_stakeholders" ADD CONSTRAINT "funding_cap_table_stakeholders_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "funding_rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_deck_reviews" ADD CONSTRAINT "funding_deck_reviews_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_deck_reviews" ADD CONSTRAINT "funding_deck_reviews_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "funding_rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_deck_reviews" ADD CONSTRAINT "funding_deck_reviews_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "funding_data_room_docs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_deck_reviews" ADD CONSTRAINT "funding_deck_reviews_doc_version_id_fkey" FOREIGN KEY ("doc_version_id") REFERENCES "funding_data_room_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "difficulty_estimate_workspace_id_keyword_locale_model_version_k" RENAME TO "difficulty_estimate_workspace_id_keyword_locale_model_versi_key";

-- RenameIndex
ALTER INDEX "graph_facts_workspace_id_source_source_record_id_fa_key" RENAME TO "graph_facts_workspace_id_source_source_record_id_fact_type__key";

