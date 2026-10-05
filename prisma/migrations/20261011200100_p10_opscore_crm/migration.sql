-- ShapesOS Phase 10 (ops-core): CRM accounts — companies, contacts, deals.
-- Lead stays the capture record. Existing leads that carry a value (the old
-- "lead with valueCents in a pipeline stage" deal) are converted once into a
-- contact (+ company by name) and a deal on the same pipeline stage; the
-- leads themselves are untouched, so the lead pipeline/kanban/forecast keep
-- working. ops_projects.deal_id becomes a real FK (dangling values are
-- re-pointed to the converted deal when they named a lead, else NULLed).
-- New tables are FORCE RLS on app.workspace_id and cascade from workspaces.

-- CreateEnum
CREATE TYPE "OpsDealStatus" AS ENUM ('open', 'won', 'lost');

-- CreateTable
CREATE TABLE "ops_companies" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "website" TEXT,
    "phone" TEXT,
    "industry" TEXT,
    "owner_id" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_contacts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "company_id" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "title" TEXT,
    "owner_id" TEXT,
    "lead_id" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_deals" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "pipeline_id" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "value_cents" INTEGER NOT NULL DEFAULT 0,
    "status" "OpsDealStatus" NOT NULL DEFAULT 'open',
    "owner_id" TEXT,
    "owner_name" TEXT,
    "contact_id" TEXT,
    "company_id" TEXT,
    "lead_id" TEXT,
    "expected_close_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "lost_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_deals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ops_companies_workspace_id_name_idx" ON "ops_companies"("workspace_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ops_companies_workspace_id_domain_key" ON "ops_companies"("workspace_id", "domain");

-- CreateIndex
CREATE INDEX "ops_contacts_workspace_id_company_id_idx" ON "ops_contacts"("workspace_id", "company_id");

-- CreateIndex
CREATE INDEX "ops_contacts_workspace_id_name_idx" ON "ops_contacts"("workspace_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ops_contacts_workspace_id_email_key" ON "ops_contacts"("workspace_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "ops_contacts_workspace_id_lead_id_key" ON "ops_contacts"("workspace_id", "lead_id");

-- CreateIndex
CREATE INDEX "ops_deals_workspace_id_pipeline_id_stage_idx" ON "ops_deals"("workspace_id", "pipeline_id", "stage");

-- CreateIndex
CREATE INDEX "ops_deals_workspace_id_status_expected_close_at_idx" ON "ops_deals"("workspace_id", "status", "expected_close_at");

-- CreateIndex
CREATE INDEX "ops_deals_workspace_id_lead_id_idx" ON "ops_deals"("workspace_id", "lead_id");

-- AddForeignKey
ALTER TABLE "ops_companies" ADD CONSTRAINT "ops_companies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_contacts" ADD CONSTRAINT "ops_contacts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_contacts" ADD CONSTRAINT "ops_contacts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "ops_companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_deals" ADD CONSTRAINT "ops_deals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_deals" ADD CONSTRAINT "ops_deals_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "crm_pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_deals" ADD CONSTRAINT "ops_deals_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "ops_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_deals" ADD CONSTRAINT "ops_deals_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "ops_companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey


-- ============================================================
-- Backfill (deterministic ids → idempotent; app code dedupes by
-- email / domain / lead id the same way).
-- ============================================================
INSERT INTO "ops_companies" ("id", "workspace_id", "name", "created_at", "updated_at")
SELECT 'cmpl_' || md5(l."workspace_id" || '|' || lower(btrim(l."company"))), l."workspace_id", min(btrim(l."company")), now(), now()
  FROM "crm_leads" l
 WHERE l."value_cents" IS NOT NULL AND btrim(coalesce(l."company", '')) <> ''
 GROUP BY l."workspace_id", lower(btrim(l."company"))
ON CONFLICT DO NOTHING;

INSERT INTO "ops_contacts" ("id", "workspace_id", "company_id", "name", "email", "phone", "title", "owner_id", "lead_id", "created_at", "updated_at")
SELECT 'ctl_' || l."id", l."workspace_id",
       CASE WHEN btrim(coalesce(l."company", '')) <> '' THEN 'cmpl_' || md5(l."workspace_id" || '|' || lower(btrim(l."company"))) END,
       l."name", nullif(lower(btrim(l."email")), ''), l."phone", l."title", l."owner_id", l."id", now(), now()
  FROM "crm_leads" l
 WHERE l."value_cents" IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "ops_deals" ("id", "workspace_id", "title", "pipeline_id", "stage", "value_cents", "status", "owner_id", "owner_name", "contact_id", "company_id", "lead_id", "closed_at", "created_at", "updated_at")
SELECT 'dll_' || l."id", l."workspace_id",
       CASE WHEN btrim(coalesce(l."company", '')) <> '' THEN btrim(l."company") || ' — ' || l."name" ELSE l."name" END,
       l."pipeline_id", l."stage", l."value_cents",
       (CASE l."stage" WHEN 'won' THEN 'won' WHEN 'lost' THEN 'lost' ELSE 'open' END)::"OpsDealStatus",
       l."owner_id", l."owner_name",
       (SELECT c."id" FROM "ops_contacts" c WHERE c."workspace_id" = l."workspace_id" AND c."lead_id" = l."id"),
       (SELECT c."company_id" FROM "ops_contacts" c WHERE c."workspace_id" = l."workspace_id" AND c."lead_id" = l."id"),
       l."id",
       CASE WHEN l."stage" IN ('won', 'lost') THEN l."updated_at" END,
       l."created_at", now()
  FROM "crm_leads" l
 WHERE l."value_cents" IS NOT NULL
ON CONFLICT DO NOTHING;

-- Dangling ops_projects.deal_id: a lead id that now has a deal → that deal;
-- anything else → NULL (it never pointed at a row).
UPDATE "ops_projects" p
   SET "deal_id" = d."id"
  FROM "ops_deals" d
 WHERE p."deal_id" IS NOT NULL AND d."lead_id" = p."deal_id" AND d."workspace_id" = p."workspace_id";
UPDATE "ops_projects" p
   SET "deal_id" = NULL
 WHERE p."deal_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ops_deals" d WHERE d."id" = p."deal_id");

-- AddForeignKey
ALTER TABLE "ops_projects" ADD CONSTRAINT "ops_projects_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "ops_deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- RLS: same tenant-isolation pattern as the phase-16/17 migrations.
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ops_companies', 'ops_contacts', 'ops_deals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL ' ||
      'USING (workspace_id = current_setting(''app.workspace_id'', true)) ' ||
      'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;
