-- ShapesOS Phase 11 (bizsync): QuickBooks Online / Xero accounting connectors.
--
-- ops_accounting_links: the chart-of-accounts map shared by both providers
-- (one row per local account and provider; suggested -> confirmed by a person).
-- ops_accounting_exports: the export ledger — one row per provider + source
-- document, claimed before the remote call (second export = no-op; a crashed
-- one retries with the same provider idempotency key). A CHECK keeps the
-- status set closed and an exported row must carry its remote id.
-- FORCE RLS on the app.workspace_id GUC; both cascade from workspaces (links
-- also from the local account).

-- CreateTable
CREATE TABLE "ops_accounting_links" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "remote_account_id" TEXT NOT NULL,
    "remote_code" TEXT,
    "remote_name" TEXT NOT NULL,
    "remote_type" TEXT,
    "status" TEXT NOT NULL DEFAULT 'suggested',
    "match_reason" TEXT,
    "confirmed_by" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_accounting_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_accounting_exports" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "doc_type" TEXT NOT NULL,
    "local_id" TEXT NOT NULL,
    "entry_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "remote_id" TEXT,
    "remote_number" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "last_error" TEXT,
    "exported_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_accounting_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ops_accounting_links_workspace_id_provider_remote_account_i_idx" ON "ops_accounting_links"("workspace_id", "provider", "remote_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "ops_accounting_links_workspace_id_provider_account_id_key" ON "ops_accounting_links"("workspace_id", "provider", "account_id");

-- CreateIndex
CREATE INDEX "ops_accounting_exports_workspace_id_provider_status_idx" ON "ops_accounting_exports"("workspace_id", "provider", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ops_accounting_exports_workspace_id_provider_source_key_key" ON "ops_accounting_exports"("workspace_id", "provider", "source_key");

-- AddForeignKey
ALTER TABLE "ops_accounting_links" ADD CONSTRAINT "ops_accounting_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_accounting_links" ADD CONSTRAINT "ops_accounting_links_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ops_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_accounting_exports" ADD CONSTRAINT "ops_accounting_exports_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "ops_accounting_links" ADD CONSTRAINT "ops_accounting_links_status_check" CHECK ("status" IN ('suggested', 'confirmed'));
ALTER TABLE "ops_accounting_links" ADD CONSTRAINT "ops_accounting_links_provider_check" CHECK ("provider" IN ('quickbooks', 'xero'));
ALTER TABLE "ops_accounting_exports" ADD CONSTRAINT "ops_accounting_exports_status_check" CHECK ("status" IN ('pending', 'exported', 'failed'));
ALTER TABLE "ops_accounting_exports" ADD CONSTRAINT "ops_accounting_exports_provider_check" CHECK ("provider" IN ('quickbooks', 'xero'));
ALTER TABLE "ops_accounting_exports" ADD CONSTRAINT "ops_accounting_exports_exported_has_remote" CHECK ("status" <> 'exported' OR "remote_id" IS NOT NULL);

-- ============================================================
-- RLS: tenant isolation on app.workspace_id (fail-closed).
-- ============================================================
ALTER TABLE "ops_accounting_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ops_accounting_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY ops_accounting_links_tenant_isolation ON "ops_accounting_links" FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE "ops_accounting_exports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ops_accounting_exports" FORCE ROW LEVEL SECURITY;
CREATE POLICY ops_accounting_exports_tenant_isolation ON "ops_accounting_exports" FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
