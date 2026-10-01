-- Wave 2 quick wins — WFH mode module, slice 5 (SPEC-WFH-MODE.md).
-- Team rituals: workspace-level opt-in rituals (wins, kudos, virtual coffee,
-- demo Friday) with subscriptions, participation history, and dead-ritual
-- surfacing (never auto-deleted).

CREATE TABLE "wfh_rituals" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "created_by" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "cadence" TEXT NOT NULL DEFAULT 'weekly',
  "anchor_date" TIMESTAMPTZ(6) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wfh_rituals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "wfh_rituals_workspace_id_active_idx" ON "wfh_rituals"("workspace_id", "active");
ALTER TABLE "wfh_rituals" ADD CONSTRAINT "wfh_rituals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "wfh_ritual_subscriptions" (
  "id" TEXT NOT NULL,
  "ritual_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wfh_ritual_subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "wfh_ritual_subscriptions_ritual_id_user_id_key" ON "wfh_ritual_subscriptions"("ritual_id", "user_id");
ALTER TABLE "wfh_ritual_subscriptions" ADD CONSTRAINT "wfh_ritual_subscriptions_ritual_id_fkey" FOREIGN KEY ("ritual_id") REFERENCES "wfh_rituals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "wfh_ritual_participations" (
  "id" TEXT NOT NULL,
  "ritual_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "note" TEXT,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wfh_ritual_participations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "wfh_ritual_participations_ritual_id_occurred_at_idx" ON "wfh_ritual_participations"("ritual_id", "occurred_at");
ALTER TABLE "wfh_ritual_participations" ADD CONSTRAINT "wfh_ritual_participations_ritual_id_fkey" FOREIGN KEY ("ritual_id") REFERENCES "wfh_rituals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
