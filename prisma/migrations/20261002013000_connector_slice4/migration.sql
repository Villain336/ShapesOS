-- CreateEnum
CREATE TYPE "ConnectorIntroductionStatus" AS ENUM ('proposed', 'side_a_accepted', 'side_b_accepted', 'made', 'followed_up', 'declined', 'expired', 'withdrawn');

-- CreateEnum
CREATE TYPE "ConnectorIntroductionEventKind" AS ENUM ('proposed', 'tenant_approved', 'tenant_declined', 'ask_sent_to_side_a', 'side_a_accepted', 'side_a_declined', 'offer_sent_to_side_b', 'side_b_accepted', 'side_b_declined', 'intro_sent', 'followup_proposed', 'followup_sent', 'withdrawn', 'expired');

-- CreateEnum
CREATE TYPE "ConnectorIntroductionActorKind" AS ENUM ('agent', 'tenant', 'side_a', 'side_b', 'system');

-- CreateTable
CREATE TABLE "connector_agent_introductions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "person_a_id" TEXT NOT NULL,
    "person_b_id" TEXT NOT NULL,
    "status" "ConnectorIntroductionStatus" NOT NULL DEFAULT 'proposed',
    "intro_path_snapshot" JSONB NOT NULL,
    "draft_ask_message" TEXT NOT NULL,
    "draft_offer_message" TEXT NOT NULL,
    "tenant_approved" BOOLEAN NOT NULL DEFAULT false,
    "tenant_approved_by" TEXT,
    "tenant_approved_at" TIMESTAMP(3),
    "side_a_accepted_by" TEXT,
    "side_a_accepted_at" TIMESTAMP(3),
    "side_b_accepted_by" TEXT,
    "side_b_accepted_at" TIMESTAMP(3),
    "made_message" TEXT,
    "made_sent_via" TEXT,
    "made_sent_by" TEXT,
    "made_sent_at" TIMESTAMP(3),
    "declined_by" TEXT,
    "declined_at" TIMESTAMP(3),
    "decline_reason" TEXT,
    "withdrawn_by" TEXT,
    "withdrawn_at" TIMESTAMP(3),
    "expired_at" TIMESTAMP(3),
    "rate_limit_override_max_asks" INTEGER,
    "rate_limit_override_window_days" INTEGER,
    "followup_count" INTEGER NOT NULL DEFAULT 0,
    "pending_followup_draft" TEXT,
    "pending_followup_to" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connector_agent_introductions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_agent_introduction_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "introduction_id" TEXT NOT NULL,
    "kind" "ConnectorIntroductionEventKind" NOT NULL,
    "actor_kind" "ConnectorIntroductionActorKind" NOT NULL,
    "actor_identity" TEXT NOT NULL,
    "message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_agent_introduction_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "connector_agent_introductions_workspace_id_idx" ON "connector_agent_introductions"("workspace_id");

-- CreateIndex
CREATE INDEX "connector_agent_introductions_workspace_id_status_idx" ON "connector_agent_introductions"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "connector_agent_introductions_workspace_id_person_a_id_idx" ON "connector_agent_introductions"("workspace_id", "person_a_id");

-- CreateIndex
CREATE INDEX "connector_agent_introduction_events_workspace_id_idx" ON "connector_agent_introduction_events"("workspace_id");

-- CreateIndex
CREATE INDEX "connector_agent_introduction_events_introduction_id_created_idx" ON "connector_agent_introduction_events"("introduction_id", "created_at");

-- AddForeignKey
ALTER TABLE "connector_agent_introductions" ADD CONSTRAINT "connector_agent_introductions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_agent_introductions" ADD CONSTRAINT "connector_agent_introductions_person_a_id_fkey" FOREIGN KEY ("person_a_id") REFERENCES "connector_agent_persons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_agent_introductions" ADD CONSTRAINT "connector_agent_introductions_person_b_id_fkey" FOREIGN KEY ("person_b_id") REFERENCES "connector_agent_persons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_agent_introduction_events" ADD CONSTRAINT "connector_agent_introduction_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_agent_introduction_events" ADD CONSTRAINT "connector_agent_introduction_events_introduction_id_fkey" FOREIGN KEY ("introduction_id") REFERENCES "connector_agent_introductions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Slice 4: one active Introduction per pair (no campaigns, no bulk).
-- Partial unique index — terminal states (declined/expired/withdrawn) free
-- the pair for a future proposal. Prisma cannot express this declaratively.
CREATE UNIQUE INDEX "connector_agent_introductions_active_pair_uk"
  ON "connector_agent_introductions" ("workspace_id", "person_a_id", "person_b_id")
  WHERE "status" IN ('proposed', 'side_a_accepted', 'side_b_accepted', 'made', 'followed_up');
