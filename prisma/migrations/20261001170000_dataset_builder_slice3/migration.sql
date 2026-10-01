-- Dataset Builder slice 3: Build (BUSINESS-OS-FEATURE-SPECS.md §1).
--
-- Key entities: Dataset (one per workspace × type — "the pricing
-- dataset"), DatasetVersion (an immutable versioned snapshot of the
-- applied chunk set, with the compile transform recorded in settings),
-- and DatasetVersionChunk (per-chunk lineage: which version ← which
-- chunk ← which classification ← which source/document, plus the model
-- lineage — engine + engine_version — copied at compile time).
--
-- The zero-orphaned-data invariant extends down to compiled snapshots:
-- version_id, chunk_id, and classification_id are all NOT NULL FKs with
-- ON DELETE CASCADE — a version chunk can never point at a missing
-- version, chunk, or classification, and deleting a chunk (or its
-- document/source) removes it from every version snapshot with it.

-- CreateTable
CREATE TABLE "datasets" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "type" "DatasetType" NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "datasets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "datasets_workspace_id_type_key" ON "datasets"("workspace_id", "type");

-- CreateTable
CREATE TABLE "dataset_versions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "dataset_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "chunk_count" INTEGER NOT NULL,
    "settings" JSONB NOT NULL,
    "compiled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dataset_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dataset_versions_dataset_id_version_key" ON "dataset_versions"("dataset_id", "version");

-- CreateIndex
CREATE INDEX "dataset_versions_workspace_id_dataset_id_idx" ON "dataset_versions"("workspace_id", "dataset_id");

-- CreateTable
CREATE TABLE "dataset_version_chunks" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "chunk_id" TEXT NOT NULL,
    "classification_id" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "engine_version" TEXT NOT NULL,
    "compiled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dataset_version_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dataset_version_chunks_version_id_chunk_id_key" ON "dataset_version_chunks"("version_id", "chunk_id");

-- CreateIndex
CREATE INDEX "dataset_version_chunks_workspace_id_version_id_idx" ON "dataset_version_chunks"("workspace_id", "version_id");

-- AddForeignKey
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_versions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_versions_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "datasets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_version_chunks" ADD CONSTRAINT "dataset_version_chunks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_version_chunks" ADD CONSTRAINT "dataset_version_chunks_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "dataset_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_version_chunks" ADD CONSTRAINT "dataset_version_chunks_chunk_id_fkey" FOREIGN KEY ("chunk_id") REFERENCES "dataset_chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_version_chunks" ADD CONSTRAINT "dataset_version_chunks_classification_id_fkey" FOREIGN KEY ("classification_id") REFERENCES "dataset_classifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
