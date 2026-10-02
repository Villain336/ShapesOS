-- Connector Agent slice 1: graph core (tenant-scoped, vault-held).
-- Pruned by content from `prisma migrate diff`; pre-existing drift untouched.
-- Idempotent: safe to re-run (type/index/constraint guards).

-- CreateEnum
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ConnectorCompanySizeBand') THEN CREATE TYPE "ConnectorCompanySizeBand" AS ENUM ('solo', 'startup', 'smb', 'midmarket', 'enterprise'); END IF; END $$;

-- CreateEnum
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ConnectorCompanyRelationship') THEN CREATE TYPE "ConnectorCompanyRelationship" AS ENUM ('customer', 'prospect', 'investor', 'partner', 'vendor'); END IF; END $$;

-- CreateEnum
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ConnectorImportSource') THEN CREATE TYPE "ConnectorImportSource" AS ENUM ('manual', 'csv', 'email', 'calendar', 'boardy_starter'); END IF; END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "connector_agent_import_batches" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "source" "ConnectorImportSource" NOT NULL,
    "consented_by" TEXT NOT NULL,
    "consented_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connector_agent_import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "connector_agent_persons" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "handles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "import_batch_id" TEXT,
    "consented_by" TEXT NOT NULL,
    "consented_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connector_agent_persons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "connector_agent_companies" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT,
    "size_band" "ConnectorCompanySizeBand",
    "relationship" "ConnectorCompanyRelationship",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connector_agent_companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "connector_agent_employments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "title" TEXT,
    "start_year" INTEGER,
    "end_year" INTEGER,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connector_agent_employments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "connector_agent_relationships" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "warmth_score" INTEGER NOT NULL DEFAULT 0,
    "warmth_computed_at" TIMESTAMP(3),
    "last_touch_at" TIMESTAMP(3),
    "touch_count" INTEGER NOT NULL DEFAULT 0,
    "inbound_count" INTEGER NOT NULL DEFAULT 0,
    "outbound_count" INTEGER NOT NULL DEFAULT 0,
    "last_reciprocal_touch_at" TIMESTAMP(3),
    "notes" TEXT,
    "boundaries" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connector_agent_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "connector_agent_import_batches_workspace_id_idx" ON "connector_agent_import_batches"("workspace_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "connector_agent_persons_workspace_id_idx" ON "connector_agent_persons"("workspace_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "connector_agent_companies_workspace_id_idx" ON "connector_agent_companies"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "connector_agent_companies_workspace_id_name_key" ON "connector_agent_companies"("workspace_id", "name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "connector_agent_employments_workspace_id_idx" ON "connector_agent_employments"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "connector_agent_employments_workspace_id_person_id_company__key" ON "connector_agent_employments"("workspace_id", "person_id", "company_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "connector_agent_relationships_person_id_key" ON "connector_agent_relationships"("person_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "connector_agent_relationships_workspace_id_idx" ON "connector_agent_relationships"("workspace_id");

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connector_agent_import_batches_workspace_id_fkey') THEN ALTER TABLE "connector_agent_import_batches" ADD CONSTRAINT "connector_agent_import_batches_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connector_agent_persons_workspace_id_fkey') THEN ALTER TABLE "connector_agent_persons" ADD CONSTRAINT "connector_agent_persons_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connector_agent_persons_import_batch_id_fkey') THEN ALTER TABLE "connector_agent_persons" ADD CONSTRAINT "connector_agent_persons_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "connector_agent_import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connector_agent_companies_workspace_id_fkey') THEN ALTER TABLE "connector_agent_companies" ADD CONSTRAINT "connector_agent_companies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connector_agent_employments_workspace_id_fkey') THEN ALTER TABLE "connector_agent_employments" ADD CONSTRAINT "connector_agent_employments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connector_agent_employments_person_id_fkey') THEN ALTER TABLE "connector_agent_employments" ADD CONSTRAINT "connector_agent_employments_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "connector_agent_persons"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connector_agent_employments_company_id_fkey') THEN ALTER TABLE "connector_agent_employments" ADD CONSTRAINT "connector_agent_employments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "connector_agent_companies"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connector_agent_relationships_workspace_id_fkey') THEN ALTER TABLE "connector_agent_relationships" ADD CONSTRAINT "connector_agent_relationships_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connector_agent_relationships_person_id_fkey') THEN ALTER TABLE "connector_agent_relationships" ADD CONSTRAINT "connector_agent_relationships_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "connector_agent_persons"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;
