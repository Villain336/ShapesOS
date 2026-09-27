-- Phase 12 (embeds): tenant-scoped GrowthBook flag overrides. The admin's
-- toggle writes a per-workspace row here instead of mutating GrowthBook's
-- global default, so one tenant's experiment never leaks into another's.

-- CreateTable
CREATE TABLE "workspace_flag_overrides" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_flag_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_flag_overrides_workspace_id_key_key" ON "workspace_flag_overrides"("workspace_id", "key");
CREATE INDEX "workspace_flag_overrides_workspace_id_idx" ON "workspace_flag_overrides"("workspace_id");

-- AddForeignKey
ALTER TABLE "workspace_flag_overrides" ADD CONSTRAINT "workspace_flag_overrides_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
