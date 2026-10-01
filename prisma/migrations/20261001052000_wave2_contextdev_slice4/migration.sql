-- Wave 2 context.dev slice 4: change monitors + detected changes.
-- Monitor holds the watch (URL, cadence, last-seen hash/content). A run that
-- sees a new hash writes a MonitorChange row with a diff digest; identical
-- hashes dedup silently. Changes may link a spawned ResearchTask.

-- CreateTable
CREATE TABLE "monitors" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "cadence" TEXT NOT NULL DEFAULT 'daily',
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_seen_hash" TEXT,
    "last_content" TEXT,
    "last_checked_at" TIMESTAMP(3),
    "last_change_at" TIMESTAMP(3),
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "auto_research" BOOLEAN NOT NULL DEFAULT FALSE,
    "source_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitor_changes" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "monitor_id" TEXT NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prev_hash" TEXT,
    "new_hash" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "excerpt" TEXT,
    "research_task_id" TEXT,

    CONSTRAINT "monitor_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "monitors_workspace_id_status_idx" ON "monitors"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "monitor_changes_monitor_id_detected_at_idx" ON "monitor_changes"("monitor_id", "detected_at");

-- CreateIndex
CREATE INDEX "monitor_changes_workspace_id_detected_at_idx" ON "monitor_changes"("workspace_id", "detected_at");

-- AddForeignKey
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "knowledge_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_changes" ADD CONSTRAINT "monitor_changes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_changes" ADD CONSTRAINT "monitor_changes_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_changes" ADD CONSTRAINT "monitor_changes_research_task_id_fkey" FOREIGN KEY ("research_task_id") REFERENCES "research_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
