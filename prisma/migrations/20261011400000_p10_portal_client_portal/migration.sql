-- Phase 10 (portal): client portal with magic-link login.
--   clients.portal_*        portal switch + the CRM records a client may see
--   ops_tasks.client_visible tasks shown to linked clients
--   portal_login_links      single-use 15-minute sign-in links (hash only)
--   portal_sessions         portal sessions (hash only), revocable
-- Both new tables are FORCE RLS on app.workspace_id and cascade from
-- workspaces and clients.

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "portal_company_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "portal_contact_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "portal_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "portal_lead_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "ops_tasks" ADD COLUMN     "client_visible" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "portal_login_links" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_login_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portal_sessions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    "last_seen_at" TIMESTAMP(3),
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "portal_login_links_token_hash_key" ON "portal_login_links"("token_hash");

-- CreateIndex
CREATE INDEX "portal_login_links_workspace_id_client_id_created_at_idx" ON "portal_login_links"("workspace_id", "client_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "portal_sessions_token_hash_key" ON "portal_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "portal_sessions_workspace_id_client_id_created_at_idx" ON "portal_sessions"("workspace_id", "client_id", "created_at");

-- AddForeignKey
ALTER TABLE "portal_login_links" ADD CONSTRAINT "portal_login_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_login_links" ADD CONSTRAINT "portal_login_links_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_sessions" ADD CONSTRAINT "portal_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_sessions" ADD CONSTRAINT "portal_sessions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- RLS: same tenant-isolation pattern as the other Phase 10 tables.
-- ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['portal_login_links', 'portal_sessions'] LOOP
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
