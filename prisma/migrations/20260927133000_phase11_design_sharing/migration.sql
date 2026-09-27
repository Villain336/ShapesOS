-- AlterTable
ALTER TABLE "designs" ADD COLUMN "approval_status" TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE "designs" ADD COLUMN "approval_note" TEXT;

-- CreateTable
CREATE TABLE "design_shares" (
    "id" TEXT NOT NULL,
    "design_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_by" TEXT,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "design_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "design_comments" (
    "id" TEXT NOT NULL,
    "design_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "author_name" TEXT NOT NULL,
    "author_email" TEXT,
    "body" TEXT NOT NULL,
    "element_id" TEXT,
    "x" DOUBLE PRECISION,
    "y" DOUBLE PRECISION,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "design_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "design_shares_design_id_idx" ON "design_shares"("design_id");
CREATE UNIQUE INDEX "design_shares_token_hash_key" ON "design_shares"("token_hash");
CREATE INDEX "design_comments_design_id_created_at_idx" ON "design_comments"("design_id", "created_at");

-- AddForeignKey
ALTER TABLE "design_shares" ADD CONSTRAINT "design_shares_design_id_fkey" FOREIGN KEY ("design_id") REFERENCES "designs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "design_shares" ADD CONSTRAINT "design_shares_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "design_comments" ADD CONSTRAINT "design_comments_design_id_fkey" FOREIGN KEY ("design_id") REFERENCES "designs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "design_comments" ADD CONSTRAINT "design_comments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
