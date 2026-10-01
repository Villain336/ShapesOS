-- Wave 2 quick wins — WFH mode module, slice 2 (SPEC-WFH-MODE.md).
-- Async-first notifications: digest queue + per-user digest window config.

ALTER TABLE "wfh_work_modes" ADD COLUMN "digest_times_min" INTEGER[] NOT NULL DEFAULT '{}';

CREATE TABLE "wfh_digest_items" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT,
  "link" TEXT,
  "urgency" TEXT NOT NULL DEFAULT 'routine',
  "window_min" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "sent_at" TIMESTAMPTZ(6),
  "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wfh_digest_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "wfh_digest_items_workspace_id_user_id_status_window_min_idx" ON "wfh_digest_items"("workspace_id", "user_id", "status", "window_min");
ALTER TABLE "wfh_digest_items" ADD CONSTRAINT "wfh_digest_items_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
