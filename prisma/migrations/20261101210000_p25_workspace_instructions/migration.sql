-- Phase 25: shared workspace instructions. Append-only revisions; the current
-- text is the highest revision. Tenant-scoped, FORCE RLS, no UPDATE/DELETE
-- policy (history cannot be rewritten through the app role).

CREATE TABLE "workspace_instruction_revisions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_by_label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_instruction_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workspace_instruction_revisions_workspace_id_revision_key" ON "workspace_instruction_revisions"("workspace_id", "revision");

ALTER TABLE "workspace_instruction_revisions" ADD CONSTRAINT "workspace_instruction_revisions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workspace_instruction_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_instruction_revisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_instruction_revisions_select ON "workspace_instruction_revisions" FOR SELECT
  USING (workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY workspace_instruction_revisions_insert ON "workspace_instruction_revisions" FOR INSERT
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
