// Marketr — alert hub trigger catalog (milestone 13).
//
// A trigger is an event source somewhere in the product. Emitters call
// emitAlert() (lib/alerts/evaluate.ts) with one of these keys; rules match
// on the key and apply their conditions. New integrations add a TRIGGERS
// entry and call emitAlert at the source — no hub changes needed.

export interface TriggerDef {
  key: string;
  label: string;
  description: string;
  /** Condition keys this trigger supports (subset of AlertRule.conditions). */
  conditionKeys: string[];
  /** Whether a sensible dedupKey is available from the emit point. */
  dedupAvailable: boolean;
  /** Live in this build, or reserved for a later milestone. */
  live: boolean;
}

export const TRIGGERS: TriggerDef[] = [
  {
    key: "rank_drop",
    label: "Keyword rank drop",
    description: "A tracked keyword falls more than the threshold positions (or drops out of the top 100).",
    conditionKeys: ["projectIds", "keywordIds", "thresholdPositions"],
    dedupAvailable: true,
    live: true,
  },
  {
    key: "rank_gain",
    label: "Keyword rank gain",
    description: "A tracked keyword climbs more than the threshold positions, or enters the top 10.",
    conditionKeys: ["projectIds", "keywordIds", "thresholdPositions"],
    dedupAvailable: true,
    live: true,
  },
  {
    key: "ai_overview_change",
    label: "AI Overview appearance change",
    description: "Google AI Overviews start (or stop) appearing for a tracked keyword's SERP.",
    conditionKeys: ["projectIds", "keywordIds"],
    dedupAvailable: true,
    live: true,
  },
  {
    key: "fix_run",
    label: "Fix-agent run",
    description: "A scheduled fix-agent run completes or fails (per site).",
    conditionKeys: ["projectIds", "severities"],
    dedupAvailable: true,
    live: true,
  },
  {
    key: "report_ready",
    label: "Scheduled report ready",
    description: "A scheduled client report finished generating and is ready to download.",
    conditionKeys: ["projectIds"],
    dedupAvailable: true,
    live: true,
  },
  {
    key: "visibility_delta",
    label: "Visibility score weekly delta",
    description: "The composite visibility score moves beyond the threshold week-over-week.",
    conditionKeys: ["projectIds", "thresholdPoints"],
    dedupAvailable: true,
    live: true, // milestone 14 (retention loops): emitted by the daily score cron.
  },
  {
    key: "ai_citation_change",
    label: "AI answer citation change",
    description: "Your site gains or loses a citation inside Google's AI Overview / AI answer for a tracked keyword.",
    conditionKeys: ["projectIds", "keywordIds"],
    dedupAvailable: true,
    live: true, // milestone 14: emitted by the rank-check cron.
  },
  {
    key: "content_decay",
    label: "Content decay detected",
    description: "A tracked page's rankings decayed beyond the threshold — refresh or rebuild suggested.",
    conditionKeys: ["projectIds", "keywordIds", "severities"],
    dedupAvailable: true,
    live: true, // milestone 14: emitted by the weekly decay cron.
  },
  {
    key: "competitor_radar",
    label: "Competitor radar event",
    description: "A tracked competitor gained keywords, published new ranking pages, or overtook you head-to-head.",
    conditionKeys: ["projectIds"],
    dedupAvailable: true,
    live: true, // milestone 14: emitted by the weekly radar cron.
  },
  {
    key: "backlink_lost",
    label: "Backlink lost",
    description: "A backlink from a high-authority domain stops pointing at your site (detected on a complete pull).",
    conditionKeys: ["projectIds", "severities"],
    dedupAvailable: true,
    live: true, // milestone 15: emitted by the backlink pull service.
  },
  {
    key: "negative_review",
    label: "Negative review",
    description: "A 1–2 star Google review arrives for a tracked business.",
    conditionKeys: ["projectIds", "severities"],
    dedupAvailable: true,
    live: true, // milestone 16: emitted by the review ingest service.
  },
  {
    key: "local_competitor_moved",
    label: "Local competitor moved",
    description: "A tracked local competitor's rating drops or their review count surges.",
    conditionKeys: ["projectIds"],
    dedupAvailable: true,
    live: true, // milestone 16: emitted by the competitor refresh service.
  },
  {
    key: "geo_grid_change",
    label: "Geo-grid shift",
    description: "A geo-grid's map-pack coverage or average position moves beyond the threshold.",
    conditionKeys: ["projectIds", "thresholdPoints"],
    dedupAvailable: true,
    live: true, // milestone 16: emitted by the geo-grid run service.
  },
  {
    key: "programmatic_publish_failed",
    label: "Programmatic publish failed",
    description: "A programmatic SEO page failed to push to its publish target (WordPress, Webflow, or a ShapesOS site).",
    conditionKeys: ["projectIds"],
    dedupAvailable: true,
    live: true, // milestone 17 push: emitted by the programmatic push service.
  },
  {
    key: "workflow",
    label: "Workflow event",
    description: "An automation canvas workflow emits a notification (send_alert action node).",
    conditionKeys: ["projectIds"],
    dedupAvailable: true,
    live: true, // redesign: automation canvas send_alert action.
  },
  {
    key: "autopilot_killed",
    label: "Autopilot kill switch engaged",
    description: "The content autopilot kill switch was engaged — scheduled runs stop immediately.",
    conditionKeys: ["projectIds"],
    dedupAvailable: true,
    live: true, // milestone 18: emitted by the autopilot service.
  },
  {
    key: "autopilot_run_failed",
    label: "Autopilot run failed",
    description: "A scheduled content-autopilot run failed before completing.",
    conditionKeys: ["projectIds"],
    dedupAvailable: true,
    live: true, // milestone 18: emitted by the autopilot service.
  },
  {
    key: "newsletter_broadcast_failed",
    label: "Newsletter broadcast failed",
    description: "A newsletter broadcast failed to send (guardrail or Resend error).",
    conditionKeys: ["projectIds"],
    dedupAvailable: true,
    live: true, // milestone 19: emitted by the newsletter service.
  },
  {
    key: "social_post_failed",
    label: "Social post failed",
    description: "A social post failed to dispatch to Buffer after bounded retries (or hit a permanent error).",
    conditionKeys: ["projectIds"],
    dedupAvailable: true,
    live: true, // milestone 20: emitted by the social service.
  },
  {
    key: "ad_generation_failed",
    label: "Ad generation failed",
    description: "A Higgsfield ad generation job failed (provider error, submit failure, or poll timeout).",
    conditionKeys: ["projectIds"],
    dedupAvailable: true,
    live: true, // milestone 21: emitted by the ad factory service.
  },
  {
    key: "domain_purchase_failed",
    label: "Domain purchase failed",
    description: "A Porkbun domain purchase failed after confirmation (provider error or availability loss).",
    conditionKeys: ["projectIds"],
    dedupAvailable: true,
    live: true, // milestone 22: emitted by the studio service.
  },
  {
    key: "connector_error",
    label: "Connector error",
    description:
      "A connector connection needs re-authentication or reported repeated errors (detected by the connector health checker).",
    conditionKeys: [],
    dedupAvailable: true,
    live: true, // Phase B (B3): emitted by the connector health checker.
  },
  {
    key: "platform_rollout",
    label: "Platform rollout impact",
    description:
      "A confirmed Google/Bing ranking rollout (Platform-change radar, Phase 10 M2) moved your pages beyond the noise band. Verification checklist included; never auto-fix prescriptions.",
    conditionKeys: ["projectIds", "severities"],
    dedupAvailable: true,
    live: true, // Phase 10 M2: emitted by the daily platform-radar cron.
  },
  {
    key: "metering_cap_warning",
    label: "Credit usage warning",
    description:
      "Workspace credit usage crossed the spend-cap alert threshold (default 80% of cap). Fires once per billing period.",
    conditionKeys: [],
    dedupAvailable: true,
    live: true, // Phase C (W4): emitted by lib/metering/service.ts.
  },
  {
    key: "composio_budget_warning",
    label: "Composio budget warning",
    description:
      "Platform Composio hosted free-tier usage crossed 80% of the monthly allowance (20,000 calls). Fires once per period; critical when exceeded. Advisory only — never blocks an action.",
    conditionKeys: [],
    dedupAvailable: true,
    live: true, // Phase 14 slice 10: emitted by lib/integrations/actions/budget.ts.
  },
  {
    key: "composio_workspace_budget_alert",
    label: "Workspace Composio budget alert",
    description:
      "A workspace crossed its Composio call-budget alert threshold (default 80% of the monthly budget). Fires once per billing month; critical at 100%. Hard-cap workspaces also refuse new executions at 100%.",
    conditionKeys: [],
    dedupAvailable: true,
    live: true, // Phase 15 slice 4: emitted by lib/integrations/actions/budget.ts.
  },
  {
    key: "chatgpt_cpa_drift",
    label: "ChatGPT ads CPA drift",
    description:
      "A ChatGPT campaign's 7-day CPA drifted more than 20% versus the prior 7 days. Review targeting, tiers, and creative before the next flight.",
    conditionKeys: ["thresholdRatio"],
    dedupAvailable: true,
    live: true, // Wave 2 ChatGPT Ads slice 4: emitted by lib/adplatforms/chatgpt/reporting.ts.
  },
  {
    key: "legal_deadline",
    label: "Legal deadline approaching",
    description:
      "A legal/compliance deadline is approaching or overdue (escalation tiers: date needed, 90, 30, 7 days out, overdue). Emitted by the legal deadline sweep.",
    conditionKeys: ["severities"],
    dedupAvailable: true,
    live: true, // Legal slice 2: emitted by the legal deadline sweep cron.
  },
  {
    key: "legal_document_expiry",
    label: "Legal document expiring",
    description:
      "A document in the legal vault is expiring or overdue (escalation tiers: date needed, 90, 30, 7 days out, overdue). Emitted by the legal document sweep.",
    conditionKeys: ["severities"],
    dedupAvailable: true,
    live: true, // Legal slice 3: emitted by the legal document sweep cron.
  },
  {
    key: "funding_followup",
    label: "Investor follow-up due",
    description:
      "A follow-up reminder on a pipeline investor is upcoming, due today, or overdue (escalation tiers: upcoming, due_today, overdue — each fires at most once). Emitted by the funding follow-up sweep.",
    conditionKeys: ["severities"],
    dedupAvailable: true,
    live: true, // Funding slice 2: emitted by the funding follow-up sweep cron.
  },
  {
    key: "dataset_stale",
    label: "Dataset gone stale",
    description:
      "A compiled business dataset's newest data is older than the staleness threshold (default 90 days), e.g. \"Your pricing dataset is 120 days old\". Fires once per compiled version. Emitted by the dataset health sweep.",
    conditionKeys: [],
    dedupAvailable: true,
    live: true, // Phase 4b: emitted by /api/cron/dataset-health.
  },
];

export function triggerDef(key: string): TriggerDef | undefined {
  return TRIGGERS.find((t) => t.key === key);
}

/** Severities used by rule conditions and fix_run events. */
export const SEVERITIES = ["info", "warn", "critical"] as const;
export type AlertSeverity = (typeof SEVERITIES)[number];
