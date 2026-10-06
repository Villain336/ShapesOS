-- ShapesOS Phase 18.1 (WS=desk): Home as a desktop, the dock, the Today
-- briefing and the Control Center's per-person state.
--
--   user_desktop_layouts  per (workspace, member): widget grid, dock pins,
--                         briefing opt-in
--   user_recent_items     the dock's "Recent" + the ⌃Tab switcher
--   desktop_briefings     one agent-written briefing per member per day
--   user_desk_state       per person (no workspace): focus / do not disturb,
--                         voice on/off, shortcut overrides
--   notifications.held_at focus mode queues a notification instead of
--                         delivering it (released when focus ends)
--
-- The three workspace tables are FORCE RLS on the tenant GUC AND the person
-- GUC (app.user_id): only the owning member, inside the owning workspace,
-- reads or writes a row. Sessions without both GUCs see zero rows.

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "held_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "user_desktop_layouts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "layout" JSONB,
    "nav" JSONB,
    "briefing_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_desktop_layouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_recent_items" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'app',
    "visited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_recent_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "desktop_briefings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "body" TEXT,
    "sources" JSONB,
    "model" TEXT,
    "batch_key" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "ready_at" TIMESTAMP(3),

    CONSTRAINT "desktop_briefings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_desk_state" (
    "user_id" TEXT NOT NULL,
    "focus_until" TIMESTAMP(3),
    "focus_started_at" TIMESTAMP(3),
    "voice_enabled" BOOLEAN NOT NULL DEFAULT false,
    "shortcuts" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_desk_state_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_desktop_layouts_workspace_id_user_id_key" ON "user_desktop_layouts"("workspace_id", "user_id");

-- CreateIndex
CREATE INDEX "user_recent_items_workspace_id_user_id_visited_at_idx" ON "user_recent_items"("workspace_id", "user_id", "visited_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_recent_items_workspace_id_user_id_href_key" ON "user_recent_items"("workspace_id", "user_id", "href");

-- CreateIndex
CREATE INDEX "desktop_briefings_workspace_id_status_idx" ON "desktop_briefings"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "desktop_briefings_workspace_id_user_id_day_key" ON "desktop_briefings"("workspace_id", "user_id", "day");

-- CreateIndex
CREATE INDEX "notifications_user_id_held_at_idx" ON "notifications"("user_id", "held_at");

-- AddForeignKey
ALTER TABLE "user_desktop_layouts" ADD CONSTRAINT "user_desktop_layouts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_recent_items" ADD CONSTRAINT "user_recent_items_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "desktop_briefings" ADD CONSTRAINT "desktop_briefings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- RLS: tenant isolation (app.workspace_id) + owner-only (app.user_id).
-- ENABLE + FORCE; fail-closed without either GUC.
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_desktop_layouts', 'user_recent_items', 'desktop_briefings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL ' ||
      'USING (workspace_id = current_setting(''app.workspace_id'', true) AND user_id = current_setting(''app.user_id'', true)) ' ||
      'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true) AND user_id = current_setting(''app.user_id'', true))',
      t || '_owner_isolation', t
    );
  END LOOP;
END $$;
