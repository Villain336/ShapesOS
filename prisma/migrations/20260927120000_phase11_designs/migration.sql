-- CreateTable
CREATE TABLE "designs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "document" JSONB NOT NULL DEFAULT '{}',
    "thumbnail" TEXT,
    "template_key" TEXT,
    "brand_kit_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "designs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "designs_workspace_id_updated_at_idx" ON "designs"("workspace_id", "updated_at");

ALTER TABLE "designs" ADD CONSTRAINT "designs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "designs" ADD CONSTRAINT "designs_brand_kit_id_fkey" FOREIGN KEY ("brand_kit_id") REFERENCES "brand_kits"("id") ON DELETE SET NULL ON UPDATE CASCADE;
