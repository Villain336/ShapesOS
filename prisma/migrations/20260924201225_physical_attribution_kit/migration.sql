-- CreateTable
CREATE TABLE "attribution_bundle" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "campaign_name" TEXT NOT NULL,
    "destination_url" TEXT NOT NULL,
    "vanity_slug" TEXT NOT NULL,
    "utm_source" TEXT NOT NULL DEFAULT 'physical',
    "utm_medium" TEXT NOT NULL DEFAULT 'qr',
    "utm_campaign" TEXT,
    "promo_code" TEXT NOT NULL,
    "number_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "qr_style" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attribution_bundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundle_scan" (
    "id" TEXT NOT NULL,
    "bundle_id" TEXT NOT NULL,
    "ip_hash" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "user_agent" VARCHAR(512),
    "referer" VARCHAR(1024),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bundle_scan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundle_redemption" (
    "id" TEXT NOT NULL,
    "bundle_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bundle_redemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attribution_bundle_promo_code_key" ON "attribution_bundle"("promo_code");

-- CreateIndex
CREATE INDEX "attribution_bundle_workspace_id_status_idx" ON "attribution_bundle"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "attribution_bundle_workspace_id_vanity_slug_key" ON "attribution_bundle"("workspace_id", "vanity_slug");

-- CreateIndex
CREATE INDEX "bundle_scan_bundle_id_day_idx" ON "bundle_scan"("bundle_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "bundle_scan_bundle_id_ip_hash_day_key" ON "bundle_scan"("bundle_id", "ip_hash", "day");

-- CreateIndex
CREATE INDEX "bundle_redemption_bundle_id_idx" ON "bundle_redemption"("bundle_id");

-- CreateIndex
CREATE UNIQUE INDEX "bundle_redemption_bundle_id_lead_id_key" ON "bundle_redemption"("bundle_id", "lead_id");

-- AddForeignKey
ALTER TABLE "attribution_bundle" ADD CONSTRAINT "attribution_bundle_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribution_bundle" ADD CONSTRAINT "attribution_bundle_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "call_number"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_scan" ADD CONSTRAINT "bundle_scan_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "attribution_bundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_redemption" ADD CONSTRAINT "bundle_redemption_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "attribution_bundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_redemption" ADD CONSTRAINT "bundle_redemption_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
