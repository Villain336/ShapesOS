BEGIN;

-- Connector Agent slice 2 (import + consent): content-filtered migration.
-- Only statements touching connector_agent_* tables + the two new enums.
-- Pre-existing drift untouched (prisma migrate dev remains broken).

-- CreateEnum
CREATE TYPE "ConnectorImportBatchStatus" AS ENUM ('consented', 'running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "ConnectorExclusionType" AS ENUM ('domain', 'email', 'person_name');

-- AlterTable
ALTER TABLE "connector_agent_import_batches" ADD COLUMN     "completed_at" TIMESTAMP(3),
ADD COLUMN     "cursor" TEXT,
ADD COLUMN     "error" TEXT,
ADD COLUMN     "stats" JSONB,
ADD COLUMN     "status" "ConnectorImportBatchStatus" NOT NULL DEFAULT 'consented';

-- AlterTable
ALTER TABLE "connector_agent_persons" ADD COLUMN     "external_id" TEXT;

-- CreateTable
CREATE TABLE "connector_agent_source_consents" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "source" "ConnectorImportSource" NOT NULL,
    "consented_by" TEXT NOT NULL,
    "consented_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connector_agent_source_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_agent_exclusions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "type" "ConnectorExclusionType" NOT NULL,
    "value" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_agent_exclusions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "connector_agent_source_consents_workspace_id_idx" ON "connector_agent_source_consents"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "connector_agent_source_consents_workspace_id_source_key" ON "connector_agent_source_consents"("workspace_id", "source");

-- CreateIndex
CREATE INDEX "connector_agent_exclusions_workspace_id_idx" ON "connector_agent_exclusions"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "connector_agent_exclusions_workspace_id_type_value_key" ON "connector_agent_exclusions"("workspace_id", "type", "value");

-- CreateIndex
CREATE INDEX "connector_agent_import_batches_workspace_id_source_idx" ON "connector_agent_import_batches"("workspace_id", "source");

-- CreateIndex
CREATE UNIQUE INDEX "connector_agent_persons_workspace_id_external_id_key" ON "connector_agent_persons"("workspace_id", "external_id");

-- AddForeignKey
ALTER TABLE "connector_agent_source_consents" ADD CONSTRAINT "connector_agent_source_consents_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_agent_exclusions" ADD CONSTRAINT "connector_agent_exclusions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
