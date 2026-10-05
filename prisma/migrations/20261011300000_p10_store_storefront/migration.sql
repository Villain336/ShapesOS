-- ShapesOS Phase 10 (store): public storefront, cart → Stripe checkout,
-- promotions applied to orders.
--
--   ops_stores           one store per workspace, public at /shop/<slug>
--                        (slug globally unique), published flag, currency,
--                        optional tax rate / fulfilment warehouse.
--   ops_store_listings   which products a store sells: URL slug, copy, image
--                        (a workspace_files id), position, listed flag.
--   ops_orders           + source (manual | web | quote | workflow), store,
--                        buyer email/name, server-computed discount and the
--                        promotion behind it, the tenant Stripe Checkout
--                        Session id (unique per workspace → webhook
--                        idempotency), paid_at.
--   ops_promotions       + starts_at / ends_at validity window.
--   ops_products         + active (inactive products are never sold).
--
-- Both new tables are FORCE RLS on app.workspace_id and cascade from
-- workspaces. ops_stores adds ONE extra, SELECT-only policy: the public
-- storefront sets app.store_route = 'lookup' for the single read that maps
-- a slug to its workspace — and that policy only ever exposes PUBLISHED
-- stores. It cannot write through it.

-- AlterTable
ALTER TABLE "ops_products" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "ops_orders" ADD COLUMN     "customer_email" TEXT,
ADD COLUMN     "customer_name" TEXT,
ADD COLUMN     "discount_cents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "paid_at" TIMESTAMP(3),
ADD COLUMN     "promotion_code" TEXT,
ADD COLUMN     "promotion_id" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN     "store_id" TEXT,
ADD COLUMN     "stripe_session_id" TEXT;

-- AlterTable
ALTER TABLE "ops_promotions" ADD COLUMN     "ends_at" TIMESTAMP(3),
ADD COLUMN     "starts_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ops_stores" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "tax_rate_id" TEXT,
    "warehouse_id" TEXT,
    "contact_email" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_store_listings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "image_file_id" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "listed" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_store_listings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ops_stores_workspace_id_key" ON "ops_stores"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "ops_stores_slug_key" ON "ops_stores"("slug");

-- CreateIndex
CREATE INDEX "ops_store_listings_workspace_id_store_id_listed_position_idx" ON "ops_store_listings"("workspace_id", "store_id", "listed", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ops_store_listings_store_id_product_id_key" ON "ops_store_listings"("store_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "ops_store_listings_store_id_slug_key" ON "ops_store_listings"("store_id", "slug");

-- CreateIndex
CREATE INDEX "ops_orders_workspace_id_source_created_at_idx" ON "ops_orders"("workspace_id", "source", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ops_orders_workspace_id_stripe_session_id_key" ON "ops_orders"("workspace_id", "stripe_session_id");

-- AddForeignKey
ALTER TABLE "ops_orders" ADD CONSTRAINT "ops_orders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "ops_stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_orders" ADD CONSTRAINT "ops_orders_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "ops_promotions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_stores" ADD CONSTRAINT "ops_stores_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_store_listings" ADD CONSTRAINT "ops_store_listings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_store_listings" ADD CONSTRAINT "ops_store_listings_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "ops_stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_store_listings" ADD CONSTRAINT "ops_store_listings_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "ops_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Money and identity guards (the service computes these; the database holds the line).
ALTER TABLE "ops_orders" ADD CONSTRAINT "ops_orders_discount_chk"
  CHECK ("discount_cents" >= 0 AND "discount_cents" <= "subtotal_cents");
ALTER TABLE "ops_stores" ADD CONSTRAINT "ops_stores_slug_chk"
  CHECK ("slug" ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$');
ALTER TABLE "ops_stores" ADD CONSTRAINT "ops_stores_currency_chk"
  CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "ops_store_listings" ADD CONSTRAINT "ops_store_listings_slug_chk"
  CHECK ("slug" ~ '^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$');

-- Row-level security: fail-closed tenant isolation.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ops_stores', 'ops_store_listings'] LOOP
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

-- Public storefront routing (read-only, published stores only): which
-- workspace owns /shop/<slug>.
CREATE POLICY ops_stores_public_route ON "ops_stores" FOR SELECT
  USING (current_setting('app.store_route', true) = 'lookup' AND "published" = true);
