-- Persistent per-project dev sandbox (in-product browser "Dev preview" v1).
-- One sandbox per project; survives agent runs. Provider pauses it on the
-- idle timeout (hard spend bound); ShapesOS wakes it only via explicit
-- resume - autoResume on inbound traffic stays off by owner constraint.
CREATE TABLE "project_dev_sandboxes" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "sandbox_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'creating',
    "mode" TEXT NOT NULL DEFAULT 'production',
    "create_count" INTEGER NOT NULL DEFAULT 1,
    "ttl_seconds" INTEGER NOT NULL DEFAULT 900,
    "exposed_ports" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "secret_enc" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_resumed_at" TIMESTAMP(3),
    "paused_at" TIMESTAMP(3),
    "destroyed_at" TIMESTAMP(3),

    CONSTRAINT "project_dev_sandboxes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_dev_sandboxes_project_id_key" ON "project_dev_sandboxes"("project_id");
CREATE INDEX "project_dev_sandboxes_workspace_id_status_idx" ON "project_dev_sandboxes"("workspace_id", "status");

ALTER TABLE "project_dev_sandboxes" ADD CONSTRAINT "project_dev_sandboxes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_dev_sandboxes" ADD CONSTRAINT "project_dev_sandboxes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
