-- ShapesOS beta readiness (WS=legal): the public status page.
-- status_components: an operator's MANUAL state for one of the four derived
-- components (web, database, worker, queue), with a note.
-- status_incidents: the incident log operators post; `updates` is the timeline.
-- Platform-wide operational data, not tenant data: no workspace_id and no
-- row-level security on purpose. Public read goes through the cached
-- GET /api/status; writes only through requirePlatformOperator routes.

-- CreateEnum
CREATE TYPE "StatusComponentState" AS ENUM ('operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance');

-- CreateEnum
CREATE TYPE "StatusIncidentStatus" AS ENUM ('investigating', 'identified', 'monitoring', 'resolved');

-- CreateEnum
CREATE TYPE "StatusIncidentImpact" AS ENUM ('none', 'minor', 'major', 'critical');

-- CreateTable
CREATE TABLE "status_components" (
    "key" VARCHAR(32) NOT NULL,
    "state" "StatusComponentState" NOT NULL,
    "note" VARCHAR(300),
    "set_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "status_components_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "status_incidents" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(140) NOT NULL,
    "status" "StatusIncidentStatus" NOT NULL,
    "impact" "StatusIncidentImpact" NOT NULL,
    "component_keys" TEXT[],
    "updates" JSONB NOT NULL DEFAULT '[]',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "status_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "status_incidents_resolved_at_started_at_idx" ON "status_incidents"("resolved_at", "started_at");

