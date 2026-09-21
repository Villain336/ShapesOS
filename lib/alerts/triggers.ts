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
    live: false, // milestone 14 (retention loops) — rules can be created, nothing emits yet.
  },
];

export function triggerDef(key: string): TriggerDef | undefined {
  return TRIGGERS.find((t) => t.key === key);
}

/** Severities used by rule conditions and fix_run events. */
export const SEVERITIES = ["info", "warn", "critical"] as const;
export type AlertSeverity = (typeof SEVERITIES)[number];
