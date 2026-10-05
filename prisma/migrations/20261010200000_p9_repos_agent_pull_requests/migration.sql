-- ShapesOS Phase 9 (repos): continue agent work from GitHub PR feedback.
--
-- agent_pull_requests: one row per branch an agent pushed (shapes/<runId>)
-- and its pull request — the run / chat thread it belongs to, PR state,
-- rolled-up checks, the last feedback, and whether a continuation is queued.
-- Written by saveShipState (lib/ship/pull-requests.ts) under the tenant GUC.
-- github_webhook_deliveries: GitHub feedback about those PRs, one row per
-- webhook delivery id (or poller item id) — the primary key is the dedupe.
--
-- Both tables are FORCE RLS on the app.workspace_id GUC and cascade from
-- workspaces. agent_pull_requests adds ONE extra, SELECT-only policy: the
-- GitHub webhook receiver / poller sets app.github_route = 'lookup' for one
-- read that maps (repository, branch) → workspace, like the agent_jobs
-- worker-discovery policy. It cannot write through that policy.

-- CreateTable
CREATE TABLE "agent_pull_requests" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "repo_full_name" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "thread_id" TEXT,
    "pr_number" INTEGER,
    "pr_url" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pushed',
    "checks" TEXT,
    "last_feedback_at" TIMESTAMP(3),
    "last_feedback" TEXT,
    "last_feedback_url" TEXT,
    "pending_since" TIMESTAMP(3),
    "continuations" INTEGER NOT NULL DEFAULT 0,
    "last_continued_at" TIMESTAMP(3),
    "last_continued_run_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_pull_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_webhook_deliveries" (
    "delivery_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "pull_request_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "action" TEXT,
    "kind" TEXT NOT NULL,
    "author" TEXT,
    "summary" TEXT NOT NULL,
    "url" TEXT,
    "continued_run_id" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_webhook_deliveries_pkey" PRIMARY KEY ("delivery_id")
);

-- CreateIndex
CREATE INDEX "agent_pull_requests_workspace_id_state_updated_at_idx" ON "agent_pull_requests"("workspace_id", "state", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_pull_requests_repo_full_name_branch_key" ON "agent_pull_requests"("repo_full_name", "branch");

-- CreateIndex
CREATE INDEX "github_webhook_deliveries_workspace_id_received_at_idx" ON "github_webhook_deliveries"("workspace_id", "received_at");

-- CreateIndex
CREATE INDEX "github_webhook_deliveries_pull_request_id_continued_run_id_idx" ON "github_webhook_deliveries"("pull_request_id", "continued_run_id");

-- AddForeignKey
ALTER TABLE "agent_pull_requests" ADD CONSTRAINT "agent_pull_requests_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_webhook_deliveries" ADD CONSTRAINT "github_webhook_deliveries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_webhook_deliveries" ADD CONSTRAINT "github_webhook_deliveries_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "agent_pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- RLS: tenant isolation on app.workspace_id (fail-closed).
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_pull_requests', 'github_webhook_deliveries'] LOOP
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

-- GitHub routing (read-only): which workspace owns (repository, branch).
CREATE POLICY agent_pull_requests_github_route ON "agent_pull_requests" FOR SELECT
  USING (current_setting('app.github_route', true) = 'lookup');
