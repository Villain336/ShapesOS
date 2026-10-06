-- Deploy PR (WS=state): the live-watch frame relay (lib/agents/runs/watch-relay.ts).
--
-- Live watch used an in-process registry: the headed-browser recording and
-- the dashboard's SSE had to run in the same Node process. In production the
-- recording runs on the worker and the SSE is served by any of several web
-- replicas, so frames now pass through this table: one row per watched run
-- holding only the LATEST JPEG (latest-wins, exactly like the in-process bus).
-- The producer uploads a frame only while a viewer polls (watched_until), and
-- deletes the row when the stream ends — frames stay transient; the WebM in
-- shared storage remains the permanent record.
--
-- UNLOGGED on purpose: frames are high-churn and disposable, so they skip the
-- WAL (no write amplification, not shipped to replicas or PITR archives). A
-- crash empties the table, which simply ends any live watch. Prisma does not
-- model table persistence, so this is invisible to the schema-drift check.
-- An unlogged table may reference permanent tables (the reverse is refused).
--
-- FORCE RLS on workspace_id (same tenant pattern as 20261005300000_phase4a_webhooks);
-- rows cascade from workspaces and from the agent run.

-- CreateTable
CREATE UNLOGGED TABLE "agent_run_watch_frames" (
    "run_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "jpeg" BYTEA,
    "ended" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "watched_until" TIMESTAMP(3),

    CONSTRAINT "agent_run_watch_frames_pkey" PRIMARY KEY ("run_id")
);

-- CreateIndex
CREATE INDEX "agent_run_watch_frames_workspace_id_updated_at_idx" ON "agent_run_watch_frames"("workspace_id", "updated_at");

-- AddForeignKey
ALTER TABLE "agent_run_watch_frames" ADD CONSTRAINT "agent_run_watch_frames_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run_watch_frames" ADD CONSTRAINT "agent_run_watch_frames_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS: ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
ALTER TABLE "agent_run_watch_frames" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_run_watch_frames" FORCE ROW LEVEL SECURITY;
CREATE POLICY "agent_run_watch_frames_tenant_isolation" ON "agent_run_watch_frames" FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
