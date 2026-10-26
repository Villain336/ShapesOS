-- Read-only preview capability tokens for the in-product browser (v2).
-- Server-stored (revocable, auditable); hash verifies, envelope re-serves.
CREATE TABLE "project_dev_preview_tokens" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "sandbox_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_enc" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_renewed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "project_dev_preview_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_dev_preview_tokens_token_hash_key" ON "project_dev_preview_tokens"("token_hash");
CREATE INDEX "project_dev_preview_tokens_workspace_project_port_idx" ON "project_dev_preview_tokens"("workspace_id", "project_id", "port");

-- Tenant isolation, same convention as the other workspace-scoped tables.
ALTER TABLE "project_dev_preview_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_dev_preview_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY "project_dev_preview_tokens_tenant_isolation" ON "project_dev_preview_tokens" FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
