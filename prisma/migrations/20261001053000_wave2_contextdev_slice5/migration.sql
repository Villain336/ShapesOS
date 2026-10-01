-- Wave 2 context.dev slice 5: brand sync proposals.
-- A BrandSync holds a fetched Context.dev brand profile + the diff against a
-- BrandKit, pending editor approval. The live kit is only touched on approve.

-- CreateTable
CREATE TABLE "brand_syncs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "brand_kit_id" TEXT,
    "domain" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_approval',
    "profile_json" JSONB NOT NULL,
    "diff_json" JSONB NOT NULL DEFAULT '[]',
    "credits_used" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "brand_syncs_workspace_id_status_idx" ON "brand_syncs"("workspace_id", "status");

-- AddForeignKey
ALTER TABLE "brand_syncs" ADD CONSTRAINT "brand_syncs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_syncs" ADD CONSTRAINT "brand_syncs_brand_kit_id_fkey" FOREIGN KEY ("brand_kit_id") REFERENCES "brand_kits"("id") ON DELETE SET NULL ON UPDATE CASCADE;
