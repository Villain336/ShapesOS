-- Marketr — Phase 10 (SPEC-PHASE10.md §6): intelligence depth — owned data assets.
--
-- 13 new tables: data_source, serp_vendor_config, api_meter, volume_cache,
-- gsc_snapshot, platform_event, page_impact, geo_prompt_panel,
-- geo_observation, competitor_watch, competitor_change, difficulty_estimate,
-- link_verification. Additive only — no existing table is altered.
--
-- RLS: ENABLE + FORCE + tenant-isolation policy on every new table, same
-- pattern as the Phase 8/9 migrations (app.workspace_id GUC; sessions
-- without the GUC see ZERO rows — fail-closed).
--
-- Exception (SPEC §4.7): volume_cache is deliberately NOT workspace-scoped —
-- it is a shared, keyed-by-(keyword_hash, locale) dedup cache whose hits are
-- aggregate-counted and never attributed to a tenant. It still gets
-- ENABLE + FORCE RLS with a fail-closed GUC-presence policy.
--
-- Append-only tables (api_meter) and immutable-by-doctrine tables are
-- enforced in app code — no UPDATE/DELETE service methods exist for them
-- (same doctrine as mission_events / command_audit).

-- Enums (match Prisma native enum names)
CREATE TYPE "DataSourceType" AS ENUM ('gsc', 'ga4', 'serp_vendor', 'planner', 'cc_graph', 'llm_provider');
CREATE TYPE "DataSourceStatus" AS ENUM ('active', 'disconnected', 'error');
CREATE TYPE "SerpVendor" AS ENUM ('serper', 'dataforseo', 'talordata');
CREATE TYPE "VendorConfigStatus" AS ENUM ('active', 'paused', 'disabled');
CREATE TYPE "ApiMeterKind" AS ENUM ('serp_call', 'volume_lookup', 'ai_prompt', 'backlink_pull');
CREATE TYPE "GscGranularity" AS ENUM ('hourly', 'daily');
CREATE TYPE "PlatformEventSource" AS ENUM ('status_dashboard', 'search_central', 'bing_blog');
CREATE TYPE "PlatformEventType" AS ENUM ('rollout', 'docs_change', 'volatility');
CREATE TYPE "CompetitorChangeType" AS ENUM ('page_added', 'page_removed', 'content_updated', 'metadata_updated', 'structure_changed');
CREATE TYPE "CompetitorChangeStatus" AS ENUM ('new', 'reviewed', 'actioned', 'dismissed');
CREATE TYPE "GeoSentiment" AS ENUM ('positive', 'neutral', 'negative', 'unknown');
CREATE TYPE "LinkVerificationStatus" AS ENUM ('verified', 'lost', 'unknown');

-- M6 provider registry: the abstraction in §M6 reads this.
CREATE TABLE "data_source" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "type" "DataSourceType" NOT NULL,
  "config" JSONB NOT NULL,
  "status" "DataSourceStatus" NOT NULL DEFAULT 'active',
  "connected_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "data_source_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "data_source_workspace_id_type_idx" ON "data_source"("workspace_id", "type");
CREATE INDEX "data_source_workspace_id_status_idx" ON "data_source"("workspace_id", "status");

-- M6 vendor routing + circuit breaker (monthly budget cap, §4.5).
CREATE TABLE "serp_vendor_config" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "vendor" "SerpVendor" NOT NULL,
  "routing_rules" JSONB NOT NULL DEFAULT '{}',
  "monthly_budget_cap_cents" INTEGER,
  "status" "VendorConfigStatus" NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "serp_vendor_config_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "serp_vendor_config_workspace_id_vendor_key" UNIQUE ("workspace_id", "vendor")
);
CREATE INDEX "serp_vendor_config_workspace_id_status_idx" ON "serp_vendor_config"("workspace_id", "status");

-- M6/M7 cost tracking + billing input (append-only).
CREATE TABLE "api_meter" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "vendor" TEXT NOT NULL,
  "meter" "ApiMeterKind" NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "cost_usd" DECIMAL(12, 6) NOT NULL,
  "period" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "api_meter_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "api_meter_workspace_id_period_idx" ON "api_meter"("workspace_id", "period");
CREATE INDEX "api_meter_workspace_id_vendor_meter_period_idx" ON "api_meter"("workspace_id", "vendor", "meter", "period");

-- M6 volume cache: shared dedup cache, never tenant-attributed (§4.7).
CREATE TABLE "volume_cache" (
  "id" TEXT NOT NULL,
  "keyword_hash" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "volume_band" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "fetched_at" TIMESTAMPTZ(6) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "hits" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "volume_cache_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "volume_cache_keyword_hash_locale_key" UNIQUE ("keyword_hash", "locale")
);
CREATE INDEX "volume_cache_expires_at_idx" ON "volume_cache"("expires_at");

-- M1 rank truth store: aggregated GSC rows per window.
CREATE TABLE "gsc_snapshot" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "window_start" TIMESTAMPTZ(6) NOT NULL,
  "window_end" TIMESTAMPTZ(6) NOT NULL,
  "granularity" "GscGranularity" NOT NULL DEFAULT 'daily',
  "rows" JSONB NOT NULL DEFAULT '[]',
  "pulled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gsc_snapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gsc_snapshot_project_id_window_start_window_end_granularity_key"
    UNIQUE ("project_id", "window_start", "window_end", "granularity")
);
CREATE INDEX "gsc_snapshot_workspace_id_pulled_at_idx" ON "gsc_snapshot"("workspace_id", "pulled_at");

-- M2 platform-change radar: events from official sources.
CREATE TABLE "platform_event" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "source" "PlatformEventSource" NOT NULL,
  "event_type" "PlatformEventType" NOT NULL,
  "title" TEXT NOT NULL,
  "started_at" TIMESTAMPTZ(6),
  "ended_at" TIMESTAMPTZ(6),
  "url" TEXT,
  "classification_confidence" DOUBLE PRECISION,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_event_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "platform_event_workspace_id_started_at_idx" ON "platform_event"("workspace_id", "started_at");
CREATE INDEX "platform_event_source_event_type_idx" ON "platform_event"("source", "event_type");

-- M2 correlation output: per-page/per-query deltas around an event.
CREATE TABLE "page_impact" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "platform_event_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "page" TEXT NOT NULL,
  "query" TEXT,
  "delta_clicks" INTEGER,
  "delta_impressions" INTEGER,
  "impact_score" DOUBLE PRECISION,
  "confidence_band" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "page_impact_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "page_impact_platform_event_id_project_id_idx" ON "page_impact"("platform_event_id", "project_id");
CREATE INDEX "page_impact_workspace_id_impact_score_idx" ON "page_impact"("workspace_id", "impact_score");

-- M3: versioned prompt panels per AI engine.
CREATE TABLE "geo_prompt_panel" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "engine" TEXT NOT NULL,
  "prompt_set_version" INTEGER NOT NULL,
  "prompts" JSONB NOT NULL,
  "cadence" TEXT NOT NULL DEFAULT 'weekly',
  "n_reps" INTEGER NOT NULL DEFAULT 3,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "geo_prompt_panel_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "geo_prompt_panel_workspace_id_engine_prompt_set_version_key"
    UNIQUE ("workspace_id", "engine", "prompt_set_version")
);
CREATE INDEX "geo_prompt_panel_workspace_id_engine_idx" ON "geo_prompt_panel"("workspace_id", "engine");

-- M3: raw observations — never aggregated into a single score at write time.
CREATE TABLE "geo_observation" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "panel_id" TEXT NOT NULL,
  "run_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rep" INTEGER NOT NULL DEFAULT 1,
  "brand_mentioned" BOOLEAN NOT NULL DEFAULT false,
  "citation_urls" TEXT[] NOT NULL DEFAULT '{}',
  "sentiment" "GeoSentiment",
  "stability_metadata" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "geo_observation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "geo_observation_panel_id_run_at_idx" ON "geo_observation"("panel_id", "run_at");
CREATE INDEX "geo_observation_workspace_id_run_at_idx" ON "geo_observation"("workspace_id", "run_at");

-- M4: competitor discovery state.
CREATE TABLE "competitor_watch" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "competitor_domain" TEXT NOT NULL,
  "sitemap_url" TEXT,
  "last_diff_at" TIMESTAMPTZ(6),
  "new_urls" TEXT[] NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "competitor_watch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "competitor_watch_project_id_competitor_domain_key" UNIQUE ("project_id", "competitor_domain")
);
CREATE INDEX "competitor_watch_workspace_id_competitor_domain_idx" ON "competitor_watch"("workspace_id", "competitor_domain");

-- M4: detected change + semantic summary + recommended response.
CREATE TABLE "competitor_change" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "watch_id" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "change_type" "CompetitorChangeType" NOT NULL,
  "semantic_summary" TEXT,
  "why_it_matters" TEXT,
  "recommended_response" TEXT,
  "status" "CompetitorChangeStatus" NOT NULL DEFAULT 'new',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "competitor_change_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "competitor_change_watch_id_detected_at_idx" ON "competitor_change"("watch_id", "detected_at");
CREATE INDEX "competitor_change_workspace_id_status_idx" ON "competitor_change"("workspace_id", "status");

-- M5: versioned difficulty outputs with input provenance.
CREATE TABLE "difficulty_estimate" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "keyword" TEXT NOT NULL,
  "locale" TEXT NOT NULL DEFAULT 'en-US',
  "estimate" DOUBLE PRECISION NOT NULL,
  "uncertainty_band" JSONB,
  "inputs_provenance" JSONB,
  "model_version" TEXT NOT NULL,
  "evaluated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "difficulty_estimate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "difficulty_estimate_workspace_id_keyword_locale_model_version_key"
    UNIQUE ("workspace_id", "keyword", "locale", "model_version")
);
CREATE INDEX "difficulty_estimate_workspace_id_evaluated_at_idx" ON "difficulty_estimate"("workspace_id", "evaluated_at");

-- M7 verification battery: demand-driven link verification state.
CREATE TABLE "link_verification" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "target_url" TEXT NOT NULL,
  "source_url" TEXT NOT NULL,
  "status" "LinkVerificationStatus" NOT NULL DEFAULT 'unknown',
  "checked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "link_verification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "link_verification_workspace_id_target_url_source_url_key"
    UNIQUE ("workspace_id", "target_url", "source_url")
);
CREATE INDEX "link_verification_workspace_id_status_idx" ON "link_verification"("workspace_id", "status");

-- Foreign keys
ALTER TABLE "data_source" ADD CONSTRAINT "data_source_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "serp_vendor_config" ADD CONSTRAINT "serp_vendor_config_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "api_meter" ADD CONSTRAINT "api_meter_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gsc_snapshot" ADD CONSTRAINT "gsc_snapshot_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gsc_snapshot" ADD CONSTRAINT "gsc_snapshot_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "platform_event" ADD CONSTRAINT "platform_event_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "page_impact" ADD CONSTRAINT "page_impact_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "page_impact" ADD CONSTRAINT "page_impact_platform_event_id_fkey"
  FOREIGN KEY ("platform_event_id") REFERENCES "platform_event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "page_impact" ADD CONSTRAINT "page_impact_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "geo_prompt_panel" ADD CONSTRAINT "geo_prompt_panel_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "geo_observation" ADD CONSTRAINT "geo_observation_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "geo_observation" ADD CONSTRAINT "geo_observation_panel_id_fkey"
  FOREIGN KEY ("panel_id") REFERENCES "geo_prompt_panel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "competitor_watch" ADD CONSTRAINT "competitor_watch_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "competitor_watch" ADD CONSTRAINT "competitor_watch_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "competitor_change" ADD CONSTRAINT "competitor_change_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "competitor_change" ADD CONSTRAINT "competitor_change_watch_id_fkey"
  FOREIGN KEY ("watch_id") REFERENCES "competitor_watch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "difficulty_estimate" ADD CONSTRAINT "difficulty_estimate_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "link_verification" ADD CONSTRAINT "link_verification_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS: tenant isolation enforced at the database level. FORCE so the
-- table owner is also constrained; the tenant principal is the
-- app.workspace_id GUC. Sessions without the GUC set see ZERO rows
-- (fail-closed). volume_cache is the exception: it has no tenant
-- column (SPEC §4.7), so it gets a fail-closed GUC-presence policy.
-- ============================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'data_source','serp_vendor_config','api_meter',
    'gsc_snapshot','platform_event','page_impact',
    'geo_prompt_panel','geo_observation',
    'competitor_watch','competitor_change',
    'difficulty_estimate','link_verification'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I FOR ALL ' ||
      'USING (workspace_id = current_setting(''app.workspace_id'', true)) ' ||
      'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t, t
    );
  END LOOP;
END $$;

-- volume_cache: no workspace column — fail-closed on GUC presence.
ALTER TABLE "volume_cache" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "volume_cache" FORCE ROW LEVEL SECURITY;
CREATE POLICY volume_cache_fail_closed ON "volume_cache" FOR ALL
  USING (current_setting('app.workspace_id', true) IS NOT NULL)
  WITH CHECK (current_setting('app.workspace_id', true) IS NOT NULL);
