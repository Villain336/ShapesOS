-- ShapesOS Phase 21A round 2 (WS=agentweb): identity, delegation and commerce (M4).
-- agentweb_identity_keys: the deployment's Web Bot Auth signing keys (not tenant data:
--   no workspace_id; the private half is a secrets() envelope). At most one "active" key.
-- agentweb_delegations: one row per authorised agent web action (who delegated, scope,
--   run, expiry, tier decision). FORCE RLS.
-- agentweb_mandates: single-use, human-signed cart mandates. FORCE RLS.

-- CreateTable
CREATE TABLE "agentweb_identity_keys" (
    "id" TEXT NOT NULL,
    "public_x" TEXT NOT NULL,
    "private_enc" TEXT NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotate_after" TIMESTAMP(3) NOT NULL,
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "agentweb_identity_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agentweb_delegations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "run_id" TEXT,
    "delegated_by" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "scope" JSONB NOT NULL DEFAULT '{}',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "action" VARCHAR(24) NOT NULL,
    "url" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "decision" VARCHAR(16) NOT NULL,
    "reason" TEXT,
    "capture_id" TEXT,
    "audit_event_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agentweb_delegations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agentweb_mandates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "run_id" TEXT,
    "requested_by" TEXT NOT NULL,
    "merchant_name" TEXT NOT NULL,
    "merchant_origin" TEXT NOT NULL,
    "cart" JSONB NOT NULL,
    "cart_hash" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'pending',
    "signed_by" TEXT,
    "signed_at" TIMESTAMP(3),
    "via" VARCHAR(16),
    "alg" VARCHAR(16),
    "signature" TEXT,
    "used_at" TIMESTAMP(3),
    "checkout_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agentweb_mandates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agentweb_identity_keys_status_created_at_idx" ON "agentweb_identity_keys"("status", "created_at");

-- CreateIndex
CREATE INDEX "agentweb_delegations_workspace_id_run_id_idx" ON "agentweb_delegations"("workspace_id", "run_id");

-- CreateIndex
CREATE INDEX "agentweb_delegations_workspace_id_created_at_idx" ON "agentweb_delegations"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "agentweb_mandates_workspace_id_status_created_at_idx" ON "agentweb_mandates"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "agentweb_mandates_workspace_id_run_id_idx" ON "agentweb_mandates"("workspace_id", "run_id");

-- AddForeignKey
ALTER TABLE "agentweb_delegations" ADD CONSTRAINT "agentweb_delegations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agentweb_mandates" ADD CONSTRAINT "agentweb_mandates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- At most one active signing key per deployment (two instances racing to create the first
-- key: one insert wins, the other re-reads).
CREATE UNIQUE INDEX "agentweb_identity_keys_one_active" ON "agentweb_identity_keys"("status") WHERE "status" = 'active';

-- ============================================================
-- RLS: same tenant-isolation pattern as the phase 4a / 18 migrations.
-- ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['agentweb_delegations', 'agentweb_mandates'] LOOP
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
