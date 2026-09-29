-- Phase 16 slice 9: branded report engine — draft-for-approval send flow.
-- ReportSendApproval = the gate object for one branded report: template name
-- + pinned semver version, brand kit, period, figure payload. approve/deny/edit
-- move it through the Phase 14 gate with FileChangeLog audit entries.
-- `prisma migrate deploy` against the durable PG (:5433) is deferred to
-- phase verification; this SQL is validated on a scratch DB in the slice.

CREATE TYPE "ReportSendStatus" AS ENUM ('pending', 'flagged', 'approved', 'denied', 'rendered', 'failed');

-- Extend the audit enum with the report-gate actions (one statement each;
-- ALTER TYPE ... ADD VALUE cannot run inside a larger transaction block on
-- older Postgres, so keep them separate).
ALTER TYPE "FileChangeAction" ADD VALUE 'report_send_drafted';
ALTER TYPE "FileChangeAction" ADD VALUE 'report_send_approved';
ALTER TYPE "FileChangeAction" ADD VALUE 'report_send_denied';
ALTER TYPE "FileChangeAction" ADD VALUE 'report_send_edited';
ALTER TYPE "FileChangeAction" ADD VALUE 'report_send_flagged';
ALTER TYPE "FileChangeAction" ADD VALUE 'report_send_rendered';
ALTER TYPE "FileChangeAction" ADD VALUE 'report_send_failed';

CREATE TABLE "report_send_approvals" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "template_name" TEXT NOT NULL,
  "template_version" TEXT NOT NULL,
  "brand_kit_id" TEXT,
  "client_name" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "ReportSendStatus" NOT NULL DEFAULT 'pending',
  "review_note" TEXT,
  "pdf_path" TEXT,
  "error" TEXT,
  "created_by" TEXT NOT NULL,
  "decided_by" TEXT,
  "decided_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "report_send_approvals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "report_send_approvals_workspace_id_status_created_at_idx"
  ON "report_send_approvals"("workspace_id", "status", "created_at");
ALTER TABLE "report_send_approvals" ADD CONSTRAINT "report_send_approvals_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "report_send_approvals" ADD CONSTRAINT "report_send_approvals_brand_kit_id_fkey"
  FOREIGN KEY ("brand_kit_id") REFERENCES "brand_kits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS: same tenant-isolation pattern as phase 16 slice 5.
-- ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
DO $$
BEGIN
  EXECUTE 'ALTER TABLE "report_send_approvals" ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE "report_send_approvals" FORCE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY report_send_approvals_tenant_isolation ON "report_send_approvals" FOR ALL ' ||
          'USING (workspace_id = current_setting(''app.workspace_id'', true)) ' ||
          'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))';
END $$;
