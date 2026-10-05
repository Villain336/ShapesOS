-- ShapesOS Phase 15.4 (zernio): Zernio as a live, pre-added platform key.
-- zernio_profiles: one Zernio profile per (workspace, mode) — createProfile
--   (/v1/profiles) runs once under an advisory lock; mode separates the live
--   API from the labelled FAKE Zernio used in dev/tests.
-- zernio_accounts: the local mirror of the profile's connected accounts
--   (GET /v1/accounts) that every ownership check reads first.
-- zernio_ad_validations: validateOnly dry runs of ad creates (POST
--   /v1/ads/create) — a real create needs a passing one for the same payload.
-- zernio_account_usage: monthly connected-account metering snapshots
--   (zernio_account_month), idempotent per (workspace, month).
-- All four are FORCE RLS on the app.workspace_id GUC (fail-closed) and
-- cascade from workspaces.

-- CreateTable
CREATE TABLE "zernio_profiles" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zernio_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zernio_accounts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "profile_row_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "username" TEXT,
    "display_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "ad_account_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnected_at" TIMESTAMP(3),

    CONSTRAINT "zernio_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zernio_ad_validations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "zernio_ad_validations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zernio_account_usage" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "connected_accounts" INTEGER NOT NULL,
    "included_accounts" INTEGER NOT NULL,
    "billable_accounts" INTEGER NOT NULL,
    "account_credits" INTEGER NOT NULL DEFAULT 0,
    "managed_ads_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "managed_ads_credits" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zernio_account_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "zernio_profiles_workspace_id_mode_key" ON "zernio_profiles"("workspace_id", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "zernio_profiles_mode_profile_id_key" ON "zernio_profiles"("mode", "profile_id");

-- CreateIndex
CREATE INDEX "zernio_accounts_profile_row_id_idx" ON "zernio_accounts"("profile_row_id");

-- CreateIndex
CREATE INDEX "zernio_accounts_account_id_idx" ON "zernio_accounts"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "zernio_accounts_workspace_id_account_id_key" ON "zernio_accounts"("workspace_id", "account_id");

-- CreateIndex
CREATE INDEX "zernio_ad_validations_workspace_id_payload_hash_idx" ON "zernio_ad_validations"("workspace_id", "payload_hash");

-- CreateIndex
CREATE UNIQUE INDEX "zernio_account_usage_workspace_id_month_key" ON "zernio_account_usage"("workspace_id", "month");

-- AddForeignKey
ALTER TABLE "zernio_profiles" ADD CONSTRAINT "zernio_profiles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zernio_accounts" ADD CONSTRAINT "zernio_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zernio_accounts" ADD CONSTRAINT "zernio_accounts_profile_row_id_fkey" FOREIGN KEY ("profile_row_id") REFERENCES "zernio_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zernio_ad_validations" ADD CONSTRAINT "zernio_ad_validations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zernio_account_usage" ADD CONSTRAINT "zernio_account_usage_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- RLS: same tenant-isolation pattern as the phase-4a webhooks migration.
-- ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['zernio_profiles', 'zernio_accounts', 'zernio_ad_validations', 'zernio_account_usage'] LOOP
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

-- Closed vocabularies (the code writes only these values).
ALTER TABLE "zernio_profiles" ADD CONSTRAINT "zernio_profiles_mode_chk" CHECK ("mode" IN ('live', 'mock'));
ALTER TABLE "zernio_accounts" ADD CONSTRAINT "zernio_accounts_status_chk" CHECK ("status" IN ('connected', 'needs_reconnect', 'disconnected'));
ALTER TABLE "zernio_ad_validations" ADD CONSTRAINT "zernio_ad_validations_status_chk" CHECK ("status" IN ('passed', 'unsupported', 'failed'));
ALTER TABLE "zernio_account_usage" ADD CONSTRAINT "zernio_account_usage_status_chk" CHECK ("status" IN ('charged', 'included', 'blocked', 'error'));
ALTER TABLE "zernio_account_usage" ADD CONSTRAINT "zernio_account_usage_month_chk" CHECK ("month" ~ '^[0-9]{4}-[0-9]{2}$');
