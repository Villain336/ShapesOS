-- Wave 2 quick wins — WFH mode module, slice 7 (SPEC-WFH-MODE.md).
-- 13B learning-loop signals: behavioral facts (focus overridden, standup
-- submitted, ritual joined/retired…) for the preference-learning loop.

CREATE TABLE "wfh_learning_signals" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "signal_type" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wfh_learning_signals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "wfh_learning_signals_workspace_id_user_id_occurred_at_idx" ON "wfh_learning_signals"("workspace_id", "user_id", "occurred_at");
ALTER TABLE "wfh_learning_signals" ADD CONSTRAINT "wfh_learning_signals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
