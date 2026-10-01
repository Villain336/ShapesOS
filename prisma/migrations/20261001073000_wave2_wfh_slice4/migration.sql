-- Wave 2 quick wins — WFH mode module, slice 4 (SPEC-WFH-MODE.md).
-- Async standups: written yesterday/today/blockers updates (+optional video),
-- team/private visibility, comment + reaction thread. One standup per user per
-- workday.

CREATE TABLE "wfh_standups" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "date" TIMESTAMPTZ(6) NOT NULL,
  "yesterday" TEXT NOT NULL,
  "today" TEXT NOT NULL,
  "blockers" TEXT,
  "video_url" TEXT,
  "visibility" TEXT NOT NULL DEFAULT 'team',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wfh_standups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "wfh_standups_workspace_id_user_id_date_key" ON "wfh_standups"("workspace_id", "user_id", "date");
CREATE INDEX "wfh_standups_workspace_id_date_visibility_idx" ON "wfh_standups"("workspace_id", "date", "visibility");
ALTER TABLE "wfh_standups" ADD CONSTRAINT "wfh_standups_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "wfh_standup_comments" (
  "id" TEXT NOT NULL,
  "standup_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wfh_standup_comments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "wfh_standup_comments_standup_id_created_at_idx" ON "wfh_standup_comments"("standup_id", "created_at");
ALTER TABLE "wfh_standup_comments" ADD CONSTRAINT "wfh_standup_comments_standup_id_fkey" FOREIGN KEY ("standup_id") REFERENCES "wfh_standups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "wfh_standup_reactions" (
  "id" TEXT NOT NULL,
  "standup_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "emoji" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wfh_standup_reactions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "wfh_standup_reactions_standup_id_user_id_key" ON "wfh_standup_reactions"("standup_id", "user_id");
ALTER TABLE "wfh_standup_reactions" ADD CONSTRAINT "wfh_standup_reactions_standup_id_fkey" FOREIGN KEY ("standup_id") REFERENCES "wfh_standups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
