-- CreateEnum
CREATE TYPE "MediaApprovalStatus" AS ENUM ('draft', 'pending', 'approved', 'executed', 'expired', 'revoked');

-- CreateEnum
CREATE TYPE "MediaApprovalType" AS ENUM ('buy', 'io_brief', 'pool_draw');

-- CreateEnum
CREATE TYPE "MediaApprovalMethod" AS ENUM ('none', 'sso', 'otp', 'signed_link');

-- CreateEnum
CREATE TYPE "MediaApprovalEventAction" AS ENUM ('created', 'submitted', 'approved', 'approval_rejected', 'revoked', 'expired', 'requeued', 'executed', 'execution_halted', 'encumbered', 'encumbrance_released', 'spent', 'kill_rule_fired', 'circuit_breaker_tripped', 'emergency_stop', 'quote_refreshed');

-- CreateEnum
CREATE TYPE "BudgetPoolPeriod" AS ENUM ('monthly', 'campaign', 'one_time');

-- CreateEnum
CREATE TYPE "BudgetPoolStatus" AS ENUM ('active', 'frozen', 'exhausted');

-- CreateEnum
CREATE TYPE "PoolTransactionKind" AS ENUM ('encumber', 'spend', 'release', 'adjust');

-- CreateEnum
CREATE TYPE "MediaBuyStatus" AS ENUM ('draft', 'executing', 'executed', 'failed', 'paused');

-- CreateEnum
CREATE TYPE "KillRuleAction" AS ENUM ('pause', 'reduce_budget', 'alert');

-- CreateEnum
CREATE TYPE "CardProvider" AS ENUM ('brex', 'ramp', 'fake');

-- CreateEnum
CREATE TYPE "MediaAuditAction" AS ENUM ('pool_created', 'pool_frozen', 'pool_unfrozen', 'virtual_card_issued', 'virtual_card_attached', 'kill_rule_created', 'kill_rule_toggled', 'kill_rule_pack_seeded', 'emergency_stop', 'buy_executed', 'buy_execution_halted');

-- CreateTable
CREATE TABLE "media_audit_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" "MediaAuditAction" NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT,
    "payload_hash" TEXT NOT NULL,
    "prev_hash" TEXT NOT NULL,
    "event_hash" TEXT NOT NULL,
    "detail" JSONB,

    CONSTRAINT "media_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_approvals" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "client_id" TEXT,
    "type" "MediaApprovalType" NOT NULL,
    "status" "MediaApprovalStatus" NOT NULL DEFAULT 'draft',
    "binding_json" JSONB NOT NULL,
    "binding_hash" TEXT NOT NULL,
    "max_spend_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "pool_id" TEXT,
    "quote_id" TEXT,
    "quote_expires_at" TIMESTAMP(3),
    "drift_tolerance_json" JSONB NOT NULL DEFAULT '{"pricePct": 10, "spendPct": 5}',
    "created_by" TEXT NOT NULL,
    "approvers_json" JSONB NOT NULL DEFAULT '[]',
    "two_person_satisfied" BOOLEAN NOT NULL DEFAULT false,
    "approval_method" "MediaApprovalMethod" NOT NULL DEFAULT 'none',
    "approval_receipt" TEXT,
    "approvals_expires_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    "executed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_approval_events" (
    "id" TEXT NOT NULL,
    "approval_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" "MediaApprovalEventAction" NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "prev_hash" TEXT NOT NULL,
    "event_hash" TEXT NOT NULL,
    "detail" JSONB,

    CONSTRAINT "media_approval_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_pools" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "period" "BudgetPoolPeriod" NOT NULL,
    "cap_cents" INTEGER NOT NULL,
    "remaining_cents" INTEGER NOT NULL,
    "encumbered_cents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "platform_allowlist" TEXT[],
    "auto_approve_threshold_cents" INTEGER NOT NULL DEFAULT 0,
    "alert_thresholds_json" JSONB NOT NULL DEFAULT '[50, 75, 90]',
    "virtual_card_ref" TEXT,
    "card_provider" "CardProvider" NOT NULL DEFAULT 'fake',
    "status" "BudgetPoolStatus" NOT NULL DEFAULT 'active',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pool_transactions" (
    "id" TEXT NOT NULL,
    "pool_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "approval_id" TEXT,
    "kind" "PoolTransactionKind" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "running_remaining_cents" INTEGER NOT NULL,
    "running_encumbered_cents" INTEGER NOT NULL,
    "actor" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "pool_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_buys" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "approval_id" TEXT NOT NULL,
    "pool_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "client_ad_account_id" TEXT NOT NULL,
    "status" "MediaBuyStatus" NOT NULL DEFAULT 'draft',
    "platform_campaign_ref" TEXT,
    "receipt_url" TEXT,
    "executed_at" TIMESTAMP(3),
    "actual_spend_cents" INTEGER,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "kill_rules_registered" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_buys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kill_rules" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "client_id" TEXT,
    "name" TEXT NOT NULL,
    "scope_json" JSONB NOT NULL DEFAULT '{}',
    "condition_json" JSONB NOT NULL,
    "window" TEXT NOT NULL DEFAULT '1h',
    "action" "KillRuleAction" NOT NULL,
    "cooldown_minutes" INTEGER NOT NULL DEFAULT 60,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "last_fired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kill_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dooh_plans" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "buy_id" TEXT,
    "name" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "placements_json" JSONB NOT NULL,
    "estimate_json" JSONB NOT NULL,
    "estimate_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "creative_ids" TEXT[],
    "creative_hashes" TEXT[],
    "tracking_assignments" JSONB,
    "launch_packet_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dooh_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "launch_packets" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "approval_id" TEXT NOT NULL,
    "binding_hash" TEXT NOT NULL,
    "packet_sha256" TEXT NOT NULL,
    "pdf_url" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "generated_by" TEXT,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "launch_packets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audio_buys" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "buy_id" TEXT,
    "name" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "stations_json" JSONB NOT NULL,
    "budget_json" JSONB NOT NULL,
    "budget_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "creative_ids" TEXT[],
    "creative_hashes" TEXT[],
    "tracking_assignments" JSONB,
    "brief_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audio_buys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "io_briefs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "buy_id" TEXT,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "inventory_json" JSONB NOT NULL,
    "io_terms_json" JSONB NOT NULL,
    "max_spend_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "creative_ids" TEXT[],
    "creative_hashes" TEXT[],
    "rep_contact" JSONB,
    "signature_status" TEXT NOT NULL DEFAULT 'draft',
    "signed_at" TIMESTAMP(3),
    "proof_of_run_url" TEXT,
    "brief_pdf_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "io_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_receipts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "buy_id" TEXT NOT NULL,
    "captured_by" TEXT NOT NULL,
    "platform_invoice_ref" TEXT,
    "amount_cents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "receipt_url" TEXT,
    "parsed_terms_json" JSONB,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "reconciled" BOOLEAN NOT NULL DEFAULT false,
    "variance_cents" INTEGER,
    "approval_ref" TEXT NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_buying_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "payload_hash" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_buying_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_links" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "buy_id" TEXT,
    "placement_ref" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "destination_url" TEXT NOT NULL,
    "utm_json" JSONB NOT NULL DEFAULT '{}',
    "engine" TEXT NOT NULL DEFAULT 'marketr',
    "status" TEXT NOT NULL DEFAULT 'active',
    "scans_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tracking_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_events" (
    "id" TEXT NOT NULL,
    "link_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_agent" TEXT,
    "ip_hash" TEXT,
    "referer" TEXT,

    CONSTRAINT "scan_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_codes" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "buy_id" TEXT,
    "code" TEXT NOT NULL,
    "channel_ref" TEXT NOT NULL,
    "redemptions_count" INTEGER NOT NULL DEFAULT 0,
    "max_redemptions" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promo_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redemption_events" (
    "id" TEXT NOT NULL,
    "promo_code_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "order_ref" TEXT,

    CONSTRAINT "redemption_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_call_numbers" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "buy_id" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'callrail',
    "number_e164" TEXT NOT NULL,
    "station_ref" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "calls_count" INTEGER NOT NULL DEFAULT 0,
    "total_duration_sec" INTEGER NOT NULL DEFAULT 0,
    "first_call_at" TIMESTAMP(3),
    "last_call_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_call_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_webhook_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "call_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lift_snapshots" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "buy_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "baseline_json" JSONB NOT NULL,
    "flight_json" JSONB NOT NULL,
    "holdout_json" JSONB,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lift_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_spend_entries" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "buy_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "approval_ref" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_spend_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_audit_events_workspace_id_ts_idx" ON "media_audit_events"("workspace_id", "ts");

-- CreateIndex
CREATE INDEX "media_audit_events_workspace_id_action_idx" ON "media_audit_events"("workspace_id", "action");

-- CreateIndex
CREATE INDEX "media_approvals_workspace_id_status_idx" ON "media_approvals"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "media_approvals_workspace_id_client_id_idx" ON "media_approvals"("workspace_id", "client_id");

-- CreateIndex
CREATE INDEX "media_approval_events_approval_id_ts_idx" ON "media_approval_events"("approval_id", "ts");

-- CreateIndex
CREATE INDEX "media_approval_events_workspace_id_ts_idx" ON "media_approval_events"("workspace_id", "ts");

-- CreateIndex
CREATE INDEX "budget_pools_workspace_id_client_id_idx" ON "budget_pools"("workspace_id", "client_id");

-- CreateIndex
CREATE INDEX "budget_pools_workspace_id_status_idx" ON "budget_pools"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "pool_transactions_pool_id_ts_idx" ON "pool_transactions"("pool_id", "ts");

-- CreateIndex
CREATE INDEX "pool_transactions_workspace_id_ts_idx" ON "pool_transactions"("workspace_id", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "media_buys_approval_id_key" ON "media_buys"("approval_id");

-- CreateIndex
CREATE INDEX "media_buys_workspace_id_status_idx" ON "media_buys"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "media_buys_pool_id_idx" ON "media_buys"("pool_id");

-- CreateIndex
CREATE INDEX "kill_rules_workspace_id_enabled_idx" ON "kill_rules"("workspace_id", "enabled");

-- CreateIndex
CREATE INDEX "kill_rules_workspace_id_client_id_idx" ON "kill_rules"("workspace_id", "client_id");

-- CreateIndex
CREATE INDEX "dooh_plans_workspace_id_vendor_status_idx" ON "dooh_plans"("workspace_id", "vendor", "status");

-- CreateIndex
CREATE INDEX "launch_packets_workspace_id_plan_id_idx" ON "launch_packets"("workspace_id", "plan_id");

-- CreateIndex
CREATE INDEX "audio_buys_workspace_id_vendor_status_idx" ON "audio_buys"("workspace_id", "vendor", "status");

-- CreateIndex
CREATE INDEX "io_briefs_workspace_id_channel_signature_status_idx" ON "io_briefs"("workspace_id", "channel", "signature_status");

-- CreateIndex
CREATE INDEX "media_receipts_workspace_id_buy_id_idx" ON "media_receipts"("workspace_id", "buy_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_receipts_workspace_id_buy_id_platform_invoice_ref_key" ON "media_receipts"("workspace_id", "buy_id", "platform_invoice_ref");

-- CreateIndex
CREATE INDEX "media_buying_events_workspace_id_entity_id_ts_idx" ON "media_buying_events"("workspace_id", "entity_id", "ts");

-- CreateIndex
CREATE INDEX "tracking_links_workspace_id_buy_id_idx" ON "tracking_links"("workspace_id", "buy_id");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_links_workspace_id_slug_key" ON "tracking_links"("workspace_id", "slug");

-- CreateIndex
CREATE INDEX "scan_events_link_id_occurred_at_idx" ON "scan_events"("link_id", "occurred_at");

-- CreateIndex
CREATE INDEX "promo_codes_workspace_id_buy_id_idx" ON "promo_codes"("workspace_id", "buy_id");

-- CreateIndex
CREATE UNIQUE INDEX "promo_codes_workspace_id_code_key" ON "promo_codes"("workspace_id", "code");

-- CreateIndex
CREATE INDEX "redemption_events_promo_code_id_occurred_at_idx" ON "redemption_events"("promo_code_id", "occurred_at");

-- CreateIndex
CREATE INDEX "media_call_numbers_workspace_id_buy_id_idx" ON "media_call_numbers"("workspace_id", "buy_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_call_numbers_workspace_id_number_e164_key" ON "media_call_numbers"("workspace_id", "number_e164");

-- CreateIndex
CREATE INDEX "call_webhook_events_workspace_id_idx" ON "call_webhook_events"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "call_webhook_events_provider_event_id_key" ON "call_webhook_events"("provider", "event_id");

-- CreateIndex
CREATE INDEX "lift_snapshots_workspace_id_buy_id_source_idx" ON "lift_snapshots"("workspace_id", "buy_id", "source");

-- CreateIndex
CREATE INDEX "media_spend_entries_workspace_id_buy_id_kind_idx" ON "media_spend_entries"("workspace_id", "buy_id", "kind");

-- AddForeignKey
ALTER TABLE "media_audit_events" ADD CONSTRAINT "media_audit_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_approvals" ADD CONSTRAINT "media_approvals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_approval_events" ADD CONSTRAINT "media_approval_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_approval_events" ADD CONSTRAINT "media_approval_events_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "media_approvals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_pools" ADD CONSTRAINT "budget_pools_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pool_transactions" ADD CONSTRAINT "pool_transactions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_buys" ADD CONSTRAINT "media_buys_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kill_rules" ADD CONSTRAINT "kill_rules_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dooh_plans" ADD CONSTRAINT "dooh_plans_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "launch_packets" ADD CONSTRAINT "launch_packets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "launch_packets" ADD CONSTRAINT "launch_packets_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "dooh_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_buys" ADD CONSTRAINT "audio_buys_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "io_briefs" ADD CONSTRAINT "io_briefs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_receipts" ADD CONSTRAINT "media_receipts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_buying_events" ADD CONSTRAINT "media_buying_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_links" ADD CONSTRAINT "tracking_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_events" ADD CONSTRAINT "scan_events_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "tracking_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemption_events" ADD CONSTRAINT "redemption_events_promo_code_id_fkey" FOREIGN KEY ("promo_code_id") REFERENCES "promo_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_call_numbers" ADD CONSTRAINT "media_call_numbers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_webhook_events" ADD CONSTRAINT "call_webhook_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lift_snapshots" ADD CONSTRAINT "lift_snapshots_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_spend_entries" ADD CONSTRAINT "media_spend_entries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
