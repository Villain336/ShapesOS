-- Phase 0 — reconcile schema.prisma objects that no migration created.
-- Found by `prisma migrate diff` (migrations → schema.prisma) on a fresh DB.
-- Data-preserving: the WFH mode columns are converted in place with USING casts
-- instead of the drop/re-add Prisma would generate.

-- WFH enums (schema.prisma declares them; slice1 created TEXT columns).
CREATE TYPE "WfhMode" AS ENUM ('wfh', 'office', 'hybrid');
CREATE TYPE "WfhStandupCadence" AS ENUM ('daily', 'none');
CREATE TYPE "WfhNotificationProfile" AS ENUM ('realtime', 'batched');

ALTER TABLE "wfh_work_modes"
  ALTER COLUMN "mode" DROP DEFAULT,
  ALTER COLUMN "mode" TYPE "WfhMode" USING "mode"::"WfhMode",
  ALTER COLUMN "mode" SET DEFAULT 'office',
  ALTER COLUMN "standup_cadence" DROP DEFAULT,
  ALTER COLUMN "standup_cadence" TYPE "WfhStandupCadence" USING "standup_cadence"::"WfhStandupCadence",
  ALTER COLUMN "standup_cadence" SET DEFAULT 'daily',
  ALTER COLUMN "notification_profile" DROP DEFAULT,
  ALTER COLUMN "notification_profile" TYPE "WfhNotificationProfile" USING "notification_profile"::"WfhNotificationProfile",
  ALTER COLUMN "notification_profile" SET DEFAULT 'batched';

ALTER TABLE "wfh_mode_history"
  ALTER COLUMN "previous_mode" TYPE "WfhMode" USING "previous_mode"::"WfhMode",
  ALTER COLUMN "new_mode" TYPE "WfhMode" USING "new_mode"::"WfhMode";

CREATE INDEX IF NOT EXISTS "wfh_work_modes_workspace_id_mode_idx" ON "wfh_work_modes"("workspace_id", "mode");

-- MissionPlaneLink (Plane project link per mission) had no migration.
CREATE TABLE "mission_plane_links" (
    "id" TEXT NOT NULL,
    "mission_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "plane_slug" TEXT NOT NULL,
    "plane_project_id" TEXT NOT NULL,
    "plane_project_name" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mission_plane_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mission_plane_links_mission_id_key" ON "mission_plane_links"("mission_id");
CREATE INDEX "mission_plane_links_workspace_id_idx" ON "mission_plane_links"("workspace_id");
ALTER TABLE "mission_plane_links" ADD CONSTRAINT "mission_plane_links_mission_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "missions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mission_plane_links" ADD CONSTRAINT "mission_plane_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Indexes / defaults declared in schema.prisma but never created.
CREATE INDEX IF NOT EXISTS "obligation_templates_key_idx" ON "obligation_templates"("key");
CREATE INDEX IF NOT EXISTS "regulation_changes_key_idx" ON "regulation_changes"("key");
ALTER TABLE "dataset_versions" ALTER COLUMN "settings" SET DEFAULT '{}';
