-- Dataset Builder slice 4: Activate (BUSINESS-OS-FEATURE-SPECS.md §1).
--
-- DatasetPublish records which compiled version is live on which consumer
-- target: "briefnow" (a briefnow-dataset-adapter/v1 package the
-- parameterized FastMCP connector reads as a real business-data adapter)
-- or "rag" (the pinned snapshot the OS RAG/Feed layer grounds answers
-- in). The (dataset_id, target, version) triple is unique — republishing
-- the same version to the same target is idempotent, publishing a newer
-- version writes a new row, so "what is live where" stays auditable.
-- Cascade deletes keep publish history attached to its dataset's life.

-- CreateTable
CREATE TABLE "dataset_publishes" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "dataset_id" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "version_id" TEXT NOT NULL,
    "chunk_count" INTEGER NOT NULL,
    "artifact_ref" TEXT NOT NULL,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dataset_publishes_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "dataset_publishes" ADD CONSTRAINT "dataset_publishes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_publishes" ADD CONSTRAINT "dataset_publishes_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "datasets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "dataset_publishes_dataset_id_target_version_key" ON "dataset_publishes"("dataset_id", "target", "version");

-- CreateIndex
CREATE INDEX "dataset_publishes_workspace_id_dataset_id_target_idx" ON "dataset_publishes"("workspace_id", "dataset_id", "target");
