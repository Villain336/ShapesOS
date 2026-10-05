-- ShapesOS Phase 9 (apps): internal mini-apps (lib/apps).
-- mini_apps: one row per app (slug unique per workspace) holding the live
-- spec + version + published flag and the working draft spec.
-- mini_app_versions: immutable snapshot of every published spec version, so
-- records written under an older version stay readable.
-- mini_app_records: the scoped JSONB record store (validated server-side
-- against the spec before every write).
-- All three tables are FORCE RLS on the app.workspace_id GUC (fail-closed)
-- and cascade from workspaces.

-- CreateTable
CREATE TABLE "mini_apps" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "spec" JSONB,
    "version" INTEGER NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "draft_spec" JSONB NOT NULL,
    "draft_updated_by" TEXT,
    "created_by" TEXT NOT NULL,
    "published_by" TEXT,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mini_apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mini_app_versions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "spec" JSONB NOT NULL,
    "published_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mini_app_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mini_app_records" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "spec_version" INTEGER NOT NULL,
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mini_app_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mini_apps_workspace_id_slug_key" ON "mini_apps"("workspace_id", "slug");

-- CreateIndex
CREATE INDEX "mini_app_versions_workspace_id_idx" ON "mini_app_versions"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "mini_app_versions_app_id_version_key" ON "mini_app_versions"("app_id", "version");

-- CreateIndex
CREATE INDEX "mini_app_records_workspace_id_app_id_entity_created_at_idx" ON "mini_app_records"("workspace_id", "app_id", "entity", "created_at");

-- CreateIndex
CREATE INDEX "mini_app_records_app_id_entity_idx" ON "mini_app_records"("app_id", "entity");

-- AddForeignKey
ALTER TABLE "mini_apps" ADD CONSTRAINT "mini_apps_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mini_app_versions" ADD CONSTRAINT "mini_app_versions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mini_app_versions" ADD CONSTRAINT "mini_app_versions_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "mini_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mini_app_records" ADD CONSTRAINT "mini_app_records_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mini_app_records" ADD CONSTRAINT "mini_app_records_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "mini_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- RLS: same tenant-isolation pattern as the phase-16/17, 4a and 8 migrations.
-- ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['mini_apps', 'mini_app_versions', 'mini_app_records'] LOOP
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
