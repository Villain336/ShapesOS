// Marketr — Phase 8 G2: Campaign object shared types.
// (docs/specs/SPEC-PHASE8.md §2 G2, §4.) The object LINKS to fragment tables; it never
// re-models them. "Campaign" is overloaded across ten tables, so the model
// is `growth_campaign` in code.

import type {
  CampaignLinkedType,
  CampaignLinkRole,
  CampaignLinkSource,
  GrowthCampaignObjective,
  GrowthCampaignStatus,
  LinkProposalStatus,
} from "@prisma/client";

export type {
  CampaignLinkedType,
  CampaignLinkRole,
  CampaignLinkSource,
  GrowthCampaignObjective,
  GrowthCampaignStatus,
  LinkProposalStatus,
};

/** The 12 master-plan lifecycle stages, in canonical order. */
export const CAMPAIGN_STAGES = [
  "research",
  "offer",
  "audience",
  "messaging",
  "landing_page",
  "ads",
  "email_sms",
  "social",
  "retargeting",
  "crm_pipeline",
  "lead_scoring",
  "reporting",
] as const;

export type CampaignStageKey = (typeof CAMPAIGN_STAGES)[number];

export const CAMPAIGN_STAGE_LABELS: Record<CampaignStageKey, string> = {
  research: "Research",
  offer: "Offer",
  audience: "Audience",
  messaging: "Messaging",
  landing_page: "Landing page",
  ads: "Ads",
  email_sms: "Email/SMS",
  social: "Social",
  retargeting: "Retargeting",
  crm_pipeline: "CRM pipeline",
  lead_scoring: "Lead scoring",
  reporting: "Reporting",
};

export type CampaignStageStatus =
  | "not_started"
  | "in_progress"
  | "complete"
  | "blocked"
  | "skipped";

export const CAMPAIGN_STAGE_STATUSES: CampaignStageStatus[] = [
  "not_started",
  "in_progress",
  "complete",
  "blocked",
  "skipped",
];

export interface StageLinkedRef {
  linkedType: CampaignLinkedType;
  linkedId: string;
  stageKey: CampaignStageKey;
}

export interface CampaignStageState {
  key: CampaignStageKey;
  status: CampaignStageStatus;
  note: string | null;
  linkedRefs: StageLinkedRef[];
}

/** Default stage each fragment type lands in when attached without a target. */
export const DEFAULT_STAGE_FOR_FRAGMENT: Record<CampaignLinkedType, CampaignStageKey> = {
  mail_campaign: "ads",
  outreach_campaign: "email_sms",
  media_buy: "ads",
  ctv_campaign: "ads",
  newsletter_broadcast: "email_sms",
  social_post: "social",
  experiment: "reporting",
  recycling_brief: "messaging",
};

export const LINKED_TYPES: CampaignLinkedType[] = [
  "mail_campaign",
  "outreach_campaign",
  "media_buy",
  "ctv_campaign",
  "newsletter_broadcast",
  "social_post",
  "experiment",
  "recycling_brief",
];

export const LINKED_TYPE_LABELS: Record<CampaignLinkedType, string> = {
  mail_campaign: "Direct mail",
  outreach_campaign: "Outreach",
  media_buy: "Media buy",
  ctv_campaign: "CTV",
  newsletter_broadcast: "Newsletter",
  social_post: "Social post",
  experiment: "Experiment",
  recycling_brief: "Recycling brief",
};

/** HubSpot-style max hierarchy depth: root → child → grandchild. */
export const MAX_CAMPAIGN_DEPTH = 3;

/** Match signals the backfill proposer can emit (spec §2 G2: precision over recall). */
export type MatchSignalKind =
  | "name_similarity"
  | "utm_campaign"
  | "date_proximity"
  | "shared_audience"
  | "shared_creative";

export interface MatchSignal {
  signal: MatchSignalKind;
  detail: string;
  score: number;
}

/** A single labeled metric on a roll-up fragment — semantics always labeled. */
export interface FragmentMetric {
  key: string;
  value: number | string | null;
  /** Human-readable semantics label, e.g. "platform-reported spend (Meta)". */
  label: string;
}

/** Per-fragment provenance: where every number came from. */
export interface FragmentProvenance {
  table: string;
  fragmentId: string;
  workspaceId: string;
  fetchedAt: string;
  notes: string[];
}

export class CampaignError extends Error {
  code:
    | "not_found"
    | "validation"
    | "depth_exceeded"
    | "cycle"
    | "duplicate_link"
    | "fragment_missing"
    | "proposal_not_pending";
  constructor(code: CampaignError["code"], message: string) {
    super(message);
    this.code = code;
  }
}
