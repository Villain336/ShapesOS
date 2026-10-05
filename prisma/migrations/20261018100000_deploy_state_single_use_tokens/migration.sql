-- Deploy PR (WS=state): single-use confirmation tokens shared by every app
-- instance (lib/api/single-use-tokens.ts). Replaces the per-process Map that
-- held domain-purchase confirmation tokens (lib/studio/service.ts): with two
-- web replicas a token issued by one was unknown to the other, and a replay
-- against a different replica would not have been caught.
--
-- Only the SHA-256 of a token is stored (token_hash). Consuming a token is a
-- single DELETE ... RETURNING under the workspace GUC, so it succeeds once,
-- on any replica; a replay or a concurrent double confirm finds nothing.
-- FORCE RLS on workspace_id (same tenant pattern as 20261005300000_phase4a_webhooks);
-- rows cascade from workspaces. Expired rows are swept by the issuer.

-- CreateTable
CREATE TABLE "single_use_tokens" (
    "token_hash" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "single_use_tokens_pkey" PRIMARY KEY ("token_hash")
);

-- CreateIndex
CREATE INDEX "single_use_tokens_workspace_id_expires_at_idx" ON "single_use_tokens"("workspace_id", "expires_at");

-- AddForeignKey
ALTER TABLE "single_use_tokens" ADD CONSTRAINT "single_use_tokens_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS: ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
ALTER TABLE "single_use_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "single_use_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY "single_use_tokens_tenant_isolation" ON "single_use_tokens" FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
