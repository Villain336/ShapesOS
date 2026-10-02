-- Connector Agent slice 5: Modes + Funding/VC plug-in.
-- Pruned to slice-5 statements only (migrate dev is broken: pgcrypto
-- shadow-DB issue). Pre-existing drift untouched.
-- NOTE: the two ALTER TYPE ... ADD VALUE statements cannot run inside a
-- transaction block — apply them first, individually.

-- CreateEnum: ConnectorMode (leads / funding)
CREATE TYPE "ConnectorMode" AS ENUM ('leads', 'funding');

-- AlterEnum: new writeback lineage kinds on ConnectorIntroductionEventKind
ALTER TYPE "ConnectorIntroductionEventKind" ADD VALUE 'funding_writeback';
ALTER TYPE "ConnectorIntroductionEventKind" ADD VALUE 'funding_writeback_failed';

-- CreateTable: tenant-level mode preference (one row per workspace)
CREATE TABLE "connector_agent_settings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "mode" "ConnectorMode" NOT NULL DEFAULT 'leads',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connector_agent_settings_pkey" PRIMARY KEY ("id")
);

-- AlterTable: mode + funding link + data-room share-link lineage on introductions
ALTER TABLE "connector_agent_introductions" ADD COLUMN     "data_room_share_link_id" TEXT,
ADD COLUMN     "funding_investor_id" TEXT,
ADD COLUMN     "mode" "ConnectorMode" NOT NULL DEFAULT 'leads';

-- CreateIndex
CREATE UNIQUE INDEX "connector_agent_settings_workspace_id_key" ON "connector_agent_settings"("workspace_id");

-- CreateIndex
CREATE INDEX "connector_agent_introductions_workspace_id_mode_idx" ON "connector_agent_introductions"("workspace_id", "mode");

-- AddForeignKey
ALTER TABLE "connector_agent_settings" ADD CONSTRAINT "connector_agent_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_agent_introductions" ADD CONSTRAINT "connector_agent_introductions_funding_investor_id_fkey" FOREIGN KEY ("funding_investor_id") REFERENCES "funding_investors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_agent_introductions" ADD CONSTRAINT "connector_agent_introductions_data_room_share_link_id_fkey" FOREIGN KEY ("data_room_share_link_id") REFERENCES "funding_share_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;
