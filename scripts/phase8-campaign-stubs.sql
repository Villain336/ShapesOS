-- Phase 8 G2 battery stubs: exact DDL extracted from the preview DB (pg_dump --schema-only).
-- FK constraints are dropped (seeding order would otherwise be painful); PKs kept.

CREATE TYPE public."MediaBuyStatus" AS ENUM ('draft', 'executing', 'executed', 'failed', 'paused');
CREATE TYPE public."BroadcastStatus" AS ENUM ('draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled');
CREATE TYPE public."OutreachCampaignStatus" AS ENUM ('draft', 'checklist_pending', 'active', 'paused', 'completed', 'archived');
CREATE TYPE public."ProspectStatus" AS ENUM ('new', 'qualified', 'contacted', 'replied', 'placed', 'bounced', 'suppressed', 'declined');
CREATE TYPE public."SequenceStatus" AS ENUM ('draft', 'scheduled', 'sending', 'paused', 'completed', 'stopped', 'expired');
CREATE TYPE public."RecyclingBriefStatus" AS ENUM ('draft', 'approved', 'regenerating', 'ready');
CREATE TYPE public."SocialPostStatus" AS ENUM ('draft', 'scheduled', 'sent', 'failed', 'cancelled', 'dispatching');
CREATE TYPE public."OutreachEventType" AS ENUM ('sent', 'opened', 'clicked', 'replied', 'bounced', 'unsubscribed', 'placement_verified');
CREATE TYPE public."Plan" AS ENUM ('self_hosted', 'starter', 'pro', 'agency');
CREATE TYPE public."FileChangeAction" AS ENUM ('x_placeholder');

CREATE TABLE public.workspaces (
    id text NOT NULL,
    name text NOT NULL,
    owner_user_id text NOT NULL,
    plan public."Plan" DEFAULT 'self_hosted'::public."Plan" NOT NULL,
    white_label_logo_url text,
    white_label_custom_domain text,
    white_label_brand_color text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    visibility_weights jsonb,
    backlinks_spend_cap_usd double precision,
    local_seo_spend_cap_usd double precision,
    mcp_enabled boolean DEFAULT false NOT NULL
);
ALTER TABLE ONLY public.workspaces ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);

CREATE TABLE public.ctv_campaigns (
    id text NOT NULL,
    workspace_id text NOT NULL,
    name text NOT NULL,
    platform text NOT NULL,
    mode text DEFAULT 'concierge'::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    approval_object_id text,
    budget_cents integer,
    currency text DEFAULT 'USD'::text NOT NULL,
    flight_start timestamp(3) without time zone,
    flight_end timestamp(3) without time zone,
    targeting_json jsonb,
    creative_ids text[],
    creative_hashes text[],
    vibe_advertiser_id text,
    vibe_campaign_id text,
    vibe_test_mode boolean DEFAULT true NOT NULL,
    vibe_config_ref text,
    created_by text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.experiments (
    id text NOT NULL,
    workspace_id text NOT NULL,
    name text NOT NULL,
    hypothesis text NOT NULL,
    pie_ice_score double precision NOT NULL,
    channel text NOT NULL,
    variants_json jsonb NOT NULL,
    audience text NOT NULL,
    primary_metric text NOT NULL,
    metric_type text DEFAULT 'binomial'::text NOT NULL,
    guardrail_metrics_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    profit_guardrail_json jsonb,
    traffic_floor_note text,
    min_runtime_days integer DEFAULT 7 NOT NULL,
    stated_mde double precision NOT NULL,
    verdict text,
    baseline_rate double precision NOT NULL,
    monthly_traffic double precision NOT NULL,
    launched_at timestamp(3) without time zone,
    completed_at timestamp(3) without time zone,
    qa_report_json jsonb,
    created_by text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.mail_campaign (
    id text NOT NULL,
    workspace_id text NOT NULL,
    name text NOT NULL,
    provider_id text,
    creative_id text,
    audience_source jsonb NOT NULL,
    piece_count integer DEFAULT 0 NOT NULL,
    verified_count integer DEFAULT 0 NOT NULL,
    quarantined_count integer DEFAULT 0 NOT NULL,
    est_cost_cents integer DEFAULT 0 NOT NULL,
    actual_cost_cents integer,
    status text DEFAULT 'draft'::text NOT NULL,
    in_home_start timestamp(3) without time zone,
    in_home_end timestamp(3) without time zone,
    mailed_at timestamp(3) without time zone,
    created_by text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.media_buys (
    id text NOT NULL,
    workspace_id text NOT NULL,
    approval_id text NOT NULL,
    pool_id text NOT NULL,
    platform text NOT NULL,
    client_ad_account_id text NOT NULL,
    status public."MediaBuyStatus" DEFAULT 'draft'::public."MediaBuyStatus" NOT NULL,
    platform_campaign_ref text,
    receipt_url text,
    executed_at timestamp(3) without time zone,
    actual_spend_cents integer,
    failure_count integer DEFAULT 0 NOT NULL,
    kill_rules_registered jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.newsletter_broadcasts (
    id text NOT NULL,
    project_id text NOT NULL,
    list_id text NOT NULL,
    domain_id text NOT NULL,
    subject text NOT NULL,
    template_snapshot jsonb NOT NULL,
    brand_kit_id text,
    status public."BroadcastStatus" DEFAULT 'draft'::public."BroadcastStatus" NOT NULL,
    scheduled_at timestamp(3) without time zone,
    test_sent_at timestamp(3) without time zone,
    test_sent_to text,
    resend_broadcast_id text,
    stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    error text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.outreach_campaigns (
    id text NOT NULL,
    workspace_id text NOT NULL,
    name text NOT NULL,
    depth integer DEFAULT 1 NOT NULL,
    status public."OutreachCampaignStatus" DEFAULT 'draft'::public."OutreachCampaignStatus" NOT NULL,
    sending_domain_id text,
    daily_cap integer DEFAULT 30 NOT NULL,
    warmup_verified_at timestamp(3) without time zone,
    auth_status_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    approval_id text,
    created_by text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.outreach_events (
    id text NOT NULL,
    workspace_id text NOT NULL,
    sequence_id text NOT NULL,
    ts timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    event public."OutreachEventType" NOT NULL,
    payload_hash text NOT NULL,
    detail jsonb
);

CREATE TABLE public.outreach_prospects (
    id text NOT NULL,
    workspace_id text NOT NULL,
    campaign_id text NOT NULL,
    domain text NOT NULL,
    url text NOT NULL,
    contact_name text,
    email text,
    email_verified boolean DEFAULT false NOT NULL,
    quality_score integer DEFAULT 0 NOT NULL,
    relevance_score integer DEFAULT 0 NOT NULL,
    status public."ProspectStatus" DEFAULT 'new'::public."ProspectStatus" NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.outreach_sequences (
    id text NOT NULL,
    workspace_id text NOT NULL,
    campaign_id text NOT NULL,
    prospect_id text NOT NULL,
    depth integer NOT NULL,
    steps_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    status public."SequenceStatus" DEFAULT 'draft'::public."SequenceStatus" NOT NULL,
    sent_count integer DEFAULT 0 NOT NULL,
    reply_id text,
    stopped_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.projects (
    id text NOT NULL,
    workspace_id text NOT NULL,
    domain text NOT NULL,
    locale text DEFAULT 'en-US'::text NOT NULL,
    search_engine text DEFAULT 'google'::text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    backlinks_enabled boolean DEFAULT true NOT NULL
);

CREATE TABLE public.recycling_briefs (
    id text NOT NULL,
    workspace_id text NOT NULL,
    source_asset_id text NOT NULL,
    source_channel text NOT NULL,
    trigger_signal_json jsonb NOT NULL,
    target_channels text[],
    variant_specs_json jsonb NOT NULL,
    creative_hash_lineage_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    status public."RecyclingBriefStatus" DEFAULT 'draft'::public."RecyclingBriefStatus" NOT NULL,
    approval_id text,
    studio_routing_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.social_posts (
    id text NOT NULL,
    project_id text NOT NULL,
    content jsonb NOT NULL,
    services text[] NOT NULL,
    scheduled_for timestamp(3) without time zone,
    status public."SocialPostStatus" DEFAULT 'draft'::public."SocialPostStatus" NOT NULL,
    buffer_update_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp(3) without time zone,
    error text,
    stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    stats_synced_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

ALTER TABLE ONLY public.ctv_campaigns
    ADD CONSTRAINT ctv_campaigns_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.experiments
    ADD CONSTRAINT experiments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.mail_campaign
    ADD CONSTRAINT mail_campaign_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.media_buys
    ADD CONSTRAINT media_buys_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.newsletter_broadcasts
    ADD CONSTRAINT newsletter_broadcasts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.outreach_campaigns
    ADD CONSTRAINT outreach_campaigns_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.outreach_events
    ADD CONSTRAINT outreach_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.outreach_prospects
    ADD CONSTRAINT outreach_prospects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.outreach_sequences
    ADD CONSTRAINT outreach_sequences_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.recycling_briefs
    ADD CONSTRAINT recycling_briefs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.social_posts
    ADD CONSTRAINT social_posts_pkey PRIMARY KEY (id);
