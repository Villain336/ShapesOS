-- Dataset Builder slice 2: Structure (BUSINESS-OS-FEATURE-SPECS.md §1).
--
-- Key entities: DatasetClassification (chunk → dataset type + confidence +
-- engine lineage), DatasetReviewItem (one human decision per low-confidence
-- classification — draft-for-approval, the OS trust ladder).
--
-- The zero-orphaned-chunks invariant extends one level down: chunk_id on
-- dataset_classifications is NOT NULL with a foreign key to dataset_chunks
-- ON DELETE CASCADE — a classification can never exist without its chunk,
-- and deleting a chunk deletes its classification (and the review item,
-- which is cascade-deleted with its classification) with it.
--
-- The review queue can never lose or double-count a decision:
-- classification_id on dataset_review_items is UNIQUE, so exactly one
-- review item exists per pending classification.

-- CreateEnum
CREATE TYPE "DatasetType" AS ENUM ('faq', 'product_catalog', 'policy', 'process_sop', 'company_fact', 'pricing');

-- CreateEnum
CREATE TYPE "ClassificationStatus" AS ENUM ('applied', 'pending_review', 'rejected');

-- CreateEnum
CREATE TYPE "ReviewItemStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateTable
CREATE TABLE "dataset_classifications" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "chunk_id" TEXT NOT NULL,
    "dataset_type" "DatasetType" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "engine" TEXT NOT NULL,
    "engine_version" TEXT NOT NULL,
    "status" "ClassificationStatus" NOT NULL DEFAULT 'applied',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dataset_classifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_review_items" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "classification_id" TEXT NOT NULL,
    "status" "ReviewItemStatus" NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dataset_review_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dataset_classifications_chunk_id_engine_key" ON "dataset_classifications"("chunk_id", "engine");

-- CreateIndex
CREATE INDEX "dataset_classifications_workspace_id_dataset_type_status_idx" ON "dataset_classifications"("workspace_id", "dataset_type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_review_items_classification_id_key" ON "dataset_review_items"("classification_id");

-- CreateIndex
CREATE INDEX "dataset_review_items_workspace_id_status_idx" ON "dataset_review_items"("workspace_id", "status");

-- AddForeignKey
ALTER TABLE "dataset_classifications" ADD CONSTRAINT "dataset_classifications_chunk_id_fkey" FOREIGN KEY ("chunk_id") REFERENCES "dataset_chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_classifications" ADD CONSTRAINT "dataset_classifications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_review_items" ADD CONSTRAINT "dataset_review_items_classification_id_fkey" FOREIGN KEY ("classification_id") REFERENCES "dataset_classifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_review_items" ADD CONSTRAINT "dataset_review_items_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
