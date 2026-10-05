-- Phase 1 (H6): bind Activepieces flows to the workspace that may trigger
-- them and read their runs. The engine is host-wide; flow ids are globally
-- unique, so a flow belongs to exactly one workspace.

-- CreateTable
CREATE TABLE "automation_flow_bindings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "flow_id" TEXT NOT NULL,
    "bound_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_flow_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "automation_flow_bindings_flow_id_key" ON "automation_flow_bindings"("flow_id");

-- CreateIndex
CREATE INDEX "automation_flow_bindings_workspace_id_idx" ON "automation_flow_bindings"("workspace_id");

-- AddForeignKey
ALTER TABLE "automation_flow_bindings" ADD CONSTRAINT "automation_flow_bindings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
