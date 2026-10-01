-- Wave 2 context.dev slice 3: research tasks.
-- One row per sourced Q&A execution: question, locale, answer-shape mode,
-- structured json_content, cited source URLs, heuristic confidence, credits.

-- CreateTable
CREATE TABLE "research_tasks" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "mode" TEXT NOT NULL DEFAULT 'fast',
    "status" TEXT NOT NULL DEFAULT 'complete',
    "json_content" JSONB NOT NULL,
    "sources" TEXT[] NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "credits_used" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "research_tasks_workspace_id_created_at_idx" ON "research_tasks"("workspace_id", "created_at");

-- AddForeignKey
ALTER TABLE "research_tasks" ADD CONSTRAINT "research_tasks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
