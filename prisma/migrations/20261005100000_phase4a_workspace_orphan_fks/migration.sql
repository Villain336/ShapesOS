-- ShapesOS Phase 4a (orphaned rows): every table with a workspace_id now has
-- a foreign key to workspaces with ON DELETE CASCADE, so deleting a workspace
-- (lib/workspace/lifecycle.ts) leaves nothing behind. Before this, 25 tables
-- kept their rows forever, including MCP API keys and OAuth tokens bound to
-- a workspace that no longer existed.
--
-- The one deliberate exception is workspace_lifecycle_events: the record of a
-- deletion must survive the deletion (see 20261004100000_phase3_accounts_trial).
-- lib/workspace/__tests__/workspace-orphans-db.test.ts derives the table list
-- from the catalog and fails when a new table repeats the mistake.
--
-- Rows already orphaned (their workspace was deleted earlier) are removed
-- first; otherwise the constraints could not be validated. agent_run_events
-- and agent_run_recordings are FORCE ROW LEVEL SECURITY: lifted for the
-- cleanup so a non-superuser schema owner sees every row, restored right after.

ALTER TABLE "agent_run_events" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "agent_run_recordings" NO FORCE ROW LEVEL SECURITY;

DELETE FROM "agent_run_events" t WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
DELETE FROM "agent_run_recordings" t WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
DELETE FROM "authority_approval_events" t WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
DELETE FROM "billing_setup_idempotency" t WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
DELETE FROM "breaker_events" t WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
DELETE FROM "channel_floors" t WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
DELETE FROM "connector_health" t WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
DELETE FROM "experiment_ideas" t WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
DELETE FROM "experiments" t WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
DELETE FROM "flywheel_audit_events" t WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
DELETE FROM "mail_webhook_event" t WHERE t."workspace_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
DELETE FROM "margin_ledger" t WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
DELETE FROM "dsp_adapters" t WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
DELETE FROM "fee_schedules" t WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
DELETE FROM "marginal_curves" t WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
DELETE FROM "mcp_api_keys" t WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
DELETE FROM "mcp_oauth_clients" t WHERE t."workspace_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
DELETE FROM "mcp_oauth_codes" t WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
DELETE FROM "mcp_oauth_tokens" t WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
-- policy_decisions -> reallocation_proposals is ON DELETE RESTRICT: children first.
DELETE FROM "policy_decisions" t
 WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id")
    OR t."proposal_id" IN (SELECT p."id" FROM "reallocation_proposals" p
                            WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = p."workspace_id"));
DELETE FROM "reallocation_proposals" t WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
DELETE FROM "reallocation_runs" t WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
DELETE FROM "recycling_brief_events" t WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
DELETE FROM "recycling_briefs" t WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");
DELETE FROM "sra_envelopes" t WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = t."workspace_id");

ALTER TABLE "agent_run_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "agent_run_recordings" FORCE ROW LEVEL SECURITY;

-- CreateIndex (the cascade looks rows up by workspace_id)
CREATE INDEX "authority_approval_events_workspace_id_idx" ON "authority_approval_events"("workspace_id");
CREATE INDEX "billing_setup_idempotency_workspace_id_idx" ON "billing_setup_idempotency"("workspace_id");
CREATE INDEX "mail_webhook_event_workspace_id_idx" ON "mail_webhook_event"("workspace_id");
CREATE INDEX "mcp_oauth_clients_workspace_id_idx" ON "mcp_oauth_clients"("workspace_id");
CREATE INDEX "mcp_oauth_codes_workspace_id_idx" ON "mcp_oauth_codes"("workspace_id");
CREATE INDEX "policy_decisions_workspace_id_idx" ON "policy_decisions"("workspace_id");

-- AddForeignKey
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_run_recordings" ADD CONSTRAINT "agent_run_recordings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "authority_approval_events" ADD CONSTRAINT "authority_approval_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing_setup_idempotency" ADD CONSTRAINT "billing_setup_idempotency_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "breaker_events" ADD CONSTRAINT "breaker_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_floors" ADD CONSTRAINT "channel_floors_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "connector_health" ADD CONSTRAINT "connector_health_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dsp_adapters" ADD CONSTRAINT "dsp_adapters_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "experiment_ideas" ADD CONSTRAINT "experiment_ideas_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fee_schedules" ADD CONSTRAINT "fee_schedules_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flywheel_audit_events" ADD CONSTRAINT "flywheel_audit_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mail_webhook_event" ADD CONSTRAINT "mail_webhook_event_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "margin_ledger" ADD CONSTRAINT "margin_ledger_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marginal_curves" ADD CONSTRAINT "marginal_curves_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mcp_api_keys" ADD CONSTRAINT "mcp_api_keys_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mcp_oauth_clients" ADD CONSTRAINT "mcp_oauth_clients_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mcp_oauth_codes" ADD CONSTRAINT "mcp_oauth_codes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mcp_oauth_tokens" ADD CONSTRAINT "mcp_oauth_tokens_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reallocation_proposals" ADD CONSTRAINT "reallocation_proposals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reallocation_runs" ADD CONSTRAINT "reallocation_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recycling_brief_events" ADD CONSTRAINT "recycling_brief_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recycling_briefs" ADD CONSTRAINT "recycling_briefs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sra_envelopes" ADD CONSTRAINT "sra_envelopes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
