-- ShapesOS Phase 8 (ship): repo_profiles — the detected stack of each
-- repository an agent cloned (package manager; test / lint / build commands),
-- one row per repository per workspace, reused by later runs.
-- FORCE RLS on the app.workspace_id GUC (fail-closed), cascades from workspaces.

-- CreateTable
CREATE TABLE "repo_profiles" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "repo_full_name" TEXT NOT NULL,
    "package_manager" TEXT,
    "language" TEXT,
    "commands" JSONB NOT NULL DEFAULT '{}',
    "detected_from" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repo_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "repo_profiles_workspace_id_repo_full_name_key" ON "repo_profiles"("workspace_id", "repo_full_name");

-- AddForeignKey
ALTER TABLE "repo_profiles" ADD CONSTRAINT "repo_profiles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS: same tenant-isolation pattern as the phase-16/17 and 4a migrations.
-- ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
ALTER TABLE "repo_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "repo_profiles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "repo_profiles_tenant_isolation" ON "repo_profiles" FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
