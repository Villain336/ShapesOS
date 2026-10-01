-- Wave 2 quick wins — WFH mode module, slice 1 (SPEC-WFH-MODE.md).
-- WorkMode object (per-user mode switch) + WfhModeHistory for preference learning.

CREATE TABLE "wfh_work_modes" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "email" TEXT,
  "mode" TEXT NOT NULL DEFAULT 'office',
  "wfh_days" TEXT[] NOT NULL DEFAULT '{}',
  "focus_start_min" INTEGER NOT NULL DEFAULT 540,
  "focus_end_min" INTEGER NOT NULL DEFAULT 1020,
  "focus_block_minutes" INTEGER NOT NULL DEFAULT 90,
  "standup_cadence" TEXT NOT NULL DEFAULT 'daily',
  "notification_profile" TEXT NOT NULL DEFAULT 'batched',
  "setup_completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wfh_work_modes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "wfh_work_modes_workspace_id_user_id_key" ON "wfh_work_modes"("workspace_id", "user_id");
CREATE INDEX "wfh_work_modes_workspace_id_mode_idx" ON "wfh_work_modes"("workspace_id", "mode");
ALTER TABLE "wfh_work_modes" ADD CONSTRAINT "wfh_work_modes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "wfh_mode_history" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "work_mode_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "previous_mode" TEXT NOT NULL,
  "new_mode" TEXT NOT NULL,
  "reason" TEXT NOT NULL DEFAULT 'user_toggle',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wfh_mode_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "wfh_mode_history_work_mode_id_created_at_idx" ON "wfh_mode_history"("work_mode_id", "created_at");
ALTER TABLE "wfh_mode_history" ADD CONSTRAINT "wfh_mode_history_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wfh_mode_history" ADD CONSTRAINT "wfh_mode_history_work_mode_id_fkey" FOREIGN KEY ("work_mode_id") REFERENCES "wfh_work_modes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
