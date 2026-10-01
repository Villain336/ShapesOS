-- Dataset Builder slice 1: Ingest (BUSINESS-OS-FEATURE-SPECS.md §1).
--
-- Key entities: Source, Document, Chunk. Every Chunk keeps a NON-NULLABLE
-- pointer to its Document, and every Document keeps a NON-NULLABLE pointer
-- to its Source. Zero orphaned chunks is enforced at the DB level:
--   - document_id on dataset_chunks is NOT NULL with a foreign key to
--     dataset_documents ON DELETE CASCADE — a chunk can never exist without
--     its document, and deleting a document deletes its chunks with it
--     (never leaves them dangling).
--   - source_id on dataset_documents is NOT NULL with a foreign key to
--     dataset_sources ON DELETE CASCADE — same guarantee one level up.
-- The code-level guard is verifyNoOrphanedChunks() in lib/datasetbuilder/register.ts;
-- the in-memory store used by tests rejects chunk writes with an unknown
-- document id (ORPHAN_CHUNK_REJECTED), mirroring this FK.

-- CreateEnum
CREATE TYPE "DatasetSourceKind" AS ENUM ('upload', 'drive', 'web', 'paste');

-- CreateEnum
CREATE TYPE "DatasetDocumentStatus" AS ENUM ('pending', 'ready', 'failed');

-- CreateTable
CREATE TABLE "dataset_sources" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "kind" "DatasetSourceKind" NOT NULL,
    "name" TEXT NOT NULL,
    "external_ref" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dataset_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_documents" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mime_type" TEXT,
    "byte_size" INTEGER,
    "char_count" INTEGER NOT NULL DEFAULT 0,
    "status" "DatasetDocumentStatus" NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dataset_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_chunks" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "char_start" INTEGER NOT NULL,
    "char_end" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dataset_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dataset_sources_workspace_id_kind_idx" ON "dataset_sources"("workspace_id", "kind");

-- CreateIndex
CREATE INDEX "dataset_documents_workspace_id_source_id_idx" ON "dataset_documents"("workspace_id", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_chunks_document_id_position_key" ON "dataset_chunks"("document_id", "position");

-- AddForeignKey
ALTER TABLE "dataset_sources" ADD CONSTRAINT "dataset_sources_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_documents" ADD CONSTRAINT "dataset_documents_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Invariant: document → source is non-nullable. Deleting a source deletes
-- its documents (and, transitively, their chunks) — never orphans.
ALTER TABLE "dataset_documents" ADD CONSTRAINT "dataset_documents_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "dataset_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_chunks" ADD CONSTRAINT "dataset_chunks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Invariant: chunk → document is non-nullable. Deleting a document deletes
-- its chunks — zero orphaned chunks, enforced by the database.
ALTER TABLE "dataset_chunks" ADD CONSTRAINT "dataset_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "dataset_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
