-- ShapesOS Phase 21A (WS=agentweb): the answer engine and the agent web layer.
-- web_captures (signed receipts of pages: cited sources and browser steps),
-- web_answers (answers with claim citations and cost), agentweb_settings
-- (provider order, capture retention, per-answer credit cap) and
-- agentweb_site_capabilities (declared vs worked channels per origin).
-- All four are FORCE RLS on the app.workspace_id GUC (fail-closed).

-- CreateTable
CREATE TABLE "web_captures" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,
    "dom_hash" TEXT NOT NULL,
    "text_hash" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "screenshot_ref" TEXT,
    "body_ref" TEXT,
    "alg" VARCHAR(16) NOT NULL DEFAULT 'none',
    "signature" TEXT,
    "via" VARCHAR(24) NOT NULL,
    "provider" VARCHAR(24),
    "answer_id" TEXT,
    "run_id" TEXT,
    "step_action" VARCHAR(24),
    "step_class" VARCHAR(24),
    "tier" INTEGER,
    "retention_until" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "web_captures_pkey" PRIMARY KEY ("workspace_id","id")
);

-- CreateTable
CREATE TABLE "web_answers" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'done',
    "mock" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "capture_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "provider_cost_micro_usd" INTEGER NOT NULL DEFAULT 0,
    "model_cost_micro_usd" INTEGER NOT NULL DEFAULT 0,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "cap_credits" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "web_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agentweb_settings" (
    "workspace_id" TEXT NOT NULL,
    "provider_order" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "capture_retention_days" INTEGER NOT NULL DEFAULT 30,
    "answer_cap_credits" INTEGER NOT NULL DEFAULT 25,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agentweb_settings_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "agentweb_site_capabilities" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "declared" JSONB NOT NULL DEFAULT '{}',
    "worked" JSONB NOT NULL DEFAULT '{}',
    "flows" JSONB NOT NULL DEFAULT '[]',
    "probed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agentweb_site_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "web_captures_workspace_id_created_at_idx" ON "web_captures"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "web_captures_workspace_id_answer_id_idx" ON "web_captures"("workspace_id", "answer_id");

-- CreateIndex
CREATE INDEX "web_captures_retention_until_idx" ON "web_captures"("retention_until");

-- CreateIndex
CREATE INDEX "web_answers_workspace_id_created_at_idx" ON "web_answers"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "web_answers_workspace_id_user_id_created_at_idx" ON "web_answers"("workspace_id", "user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agentweb_site_capabilities_workspace_id_origin_key" ON "agentweb_site_capabilities"("workspace_id", "origin");

-- AddForeignKey
ALTER TABLE "web_captures" ADD CONSTRAINT "web_captures_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "web_answers" ADD CONSTRAINT "web_answers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agentweb_settings" ADD CONSTRAINT "agentweb_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agentweb_site_capabilities" ADD CONSTRAINT "agentweb_site_capabilities_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- RLS: same tenant-isolation pattern as the phase 4a / 18 migrations.
-- ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['web_captures', 'web_answers', 'agentweb_settings', 'agentweb_site_capabilities'] LOOP
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
