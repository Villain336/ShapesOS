-- Wave 2 quick wins — WFH mode module, slice 3 (SPEC-WFH-MODE.md).
-- Focus blocks (protect_focus_time, calendar-lite) + calendar connection stubs
-- with the one-time auto-decline consent gate.

CREATE TABLE "wfh_calendar_connections" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'disconnected',
  "auto_decline_consent_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wfh_calendar_connections_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "wfh_calendar_connections_workspace_id_user_id_provider_key" ON "wfh_calendar_connections"("workspace_id", "user_id", "provider");
ALTER TABLE "wfh_calendar_connections" ADD CONSTRAINT "wfh_calendar_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "wfh_focus_blocks" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "start_at" TIMESTAMPTZ(6) NOT NULL,
  "end_at" TIMESTAMPTZ(6) NOT NULL,
  "recurrence" TEXT NOT NULL DEFAULT 'none',
  "protection" TEXT NOT NULL DEFAULT 'soft',
  "source" TEXT NOT NULL DEFAULT 'user',
  "status" TEXT NOT NULL DEFAULT 'scheduled',
  "calendar_connection_id" TEXT,
  "defended_event_ids" TEXT[] NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wfh_focus_blocks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "wfh_focus_blocks_workspace_id_user_id_status_start_at_idx" ON "wfh_focus_blocks"("workspace_id", "user_id", "status", "start_at");
ALTER TABLE "wfh_focus_blocks" ADD CONSTRAINT "wfh_focus_blocks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wfh_focus_blocks" ADD CONSTRAINT "wfh_focus_blocks_calendar_connection_id_fkey" FOREIGN KEY ("calendar_connection_id") REFERENCES "wfh_calendar_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
