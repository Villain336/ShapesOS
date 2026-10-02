// Marketr — Funding/VC slice 1: Starter network domain types.
// Spec: BUSINESS-OS-FEATURE-SPECS.md §3 (Funding/VC).
//
// Guardrails (slice 1 scaffolding; full enforcement lands in Connector
// slice 4):
// 1. Boardy is the preloaded STARTER contact — the first card in the deck,
//    never the gateway. The front door is the founder's own raise workflow
//    (the target investor profile below).
// 2. Intro requests are context-rich and one-per-(contact, investor) pair:
//    no bulk creation, no spray-and-pray — Boardy's reputation is the asset.
// 3. There is NO programmatic Boardy API/MCP. https://boardy.ai/agentskill is
//    an instruction page for an EMAIL flow; Boardy's double-opt-in norms
//    govern his side.

export class FundingError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FundingError";
    this.code = code;
  }
}

/** Starter-contact identity marker — never reuse for anything else. */
export const BOARDY_STARTER_KEY = "boardy_starter";

/**
 * Rate-limit scaffold: at most this many intro requests may be created
 * THROUGH one contact (e.g. Boardy) in any rolling 24h window. Full
 * per-day/per-pair enforcement lands in Connector slice 4; the store
 * enforces this much now.
 */
export const MAX_INTRO_REQUESTS_PER_CONTACT_PER_24H = 5;

export type FundingContactSource =
  | "boardy_starter"
  | "founder_added"
  | "boardy_intro"
  | "connector_import";

export interface FundingContactView {
  id: string;
  name: string;
  role: string | null;
  handle: string | null;
  note: string | null;
  source: FundingContactSource;
  isStarterContact: boolean;
  createdAt: Date;
}

export interface FundingRoundView {
  id: string;
  name: string;
  status: string;
  isActive: boolean;
  checkSizeMin: number | null;
  checkSizeMax: number | null;
  stages: string[];
  sectors: string[];
  thesisSummary: string | null;
  targetClose: Date | null;
}

/** The founder's raise workflow entry: target investor profile. */
export interface TargetInvestorProfileInput {
  name?: string;
  checkSizeMin?: number | null;
  checkSizeMax?: number | null;
  stages?: string[];
  sectors?: string[];
  thesisSummary?: string | null;
  targetClose?: string | null; // ISO date string
}

/** Pure field validation for the target investor profile. Returns errors. */
export function validateTargetInvestorProfile(
  input: TargetInvestorProfileInput,
): string[] {
  const errors: string[] = [];
  const min = input.checkSizeMin ?? null;
  const max = input.checkSizeMax ?? null;
  if (min != null && (!Number.isFinite(min) || min < 0)) {
    errors.push("checkSizeMin must be a non-negative number.");
  }
  if (max != null && (!Number.isFinite(max) || max < 0)) {
    errors.push("checkSizeMax must be a non-negative number.");
  }
  if (min != null && max != null && min > max) {
    errors.push("checkSizeMin cannot be larger than checkSizeMax.");
  }
  for (const s of input.stages ?? []) {
    if (!s.trim()) errors.push("stages cannot contain blank entries.");
  }
  for (const s of input.sectors ?? []) {
    if (!s.trim()) errors.push("sectors cannot contain blank entries.");
  }
  if (input.targetClose) {
    const d = new Date(input.targetClose);
    if (Number.isNaN(d.getTime())) {
      errors.push("targetClose must be a valid date.");
    }
  }
  return errors;
}

export interface IntroRequestInput {
  contactId: string;
  investorId: string;
  reason: string;
  founderAsk: string;
  fitNotes?: string | null;
}

const MIN_CONTEXT_CHARS = 20;

/**
 * Pure field validation for an intro request — the context-required rule.
 * Returns human-readable errors; empty = valid. Pair-level rules
 * (one-per-pair, rate limit) are DB checks in the store.
 */
export function validateIntroRequestInput(input: IntroRequestInput): string[] {
  const errors: string[] = [];
  if (!input.contactId.trim()) errors.push("contactId is required.");
  if (!input.investorId.trim()) errors.push("investorId is required.");
  if (!input.reason.trim()) {
    errors.push("reason is required — say why this investor, why now.");
  } else if (input.reason.trim().length < MIN_CONTEXT_CHARS) {
    errors.push(
      `reason must be at least ${MIN_CONTEXT_CHARS} characters — no spray-and-pray.`,
    );
  }
  if (!input.founderAsk.trim()) {
    errors.push("founderAsk is required — say what you are asking for.");
  } else if (input.founderAsk.trim().length < MIN_CONTEXT_CHARS) {
    errors.push(
      `founderAsk must be at least ${MIN_CONTEXT_CHARS} characters — be specific.`,
    );
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Slice 2 — Investor CRM.
// ---------------------------------------------------------------------------

/** Pipeline stages in forward order. `passed`/`lost`/`won` are outcomes. */
export const INVESTOR_STAGES = [
  "target",
  "contacted",
  "meeting",
  "diligence",
  "term_sheet",
  "won",
  "lost",
  "passed",
] as const;
export type InvestorStage = (typeof INVESTOR_STAGES)[number];

/**
 * Legal stage transitions. Forward moves run down the pipeline; one-step
 * backward moves re-open a conversation (re-engagement); any active stage can
 * resolve to an outcome (won/lost/passed); outcomes re-open at target.
 * `won` is terminal — the deal is done, a new round is a new record.
 */
export const STAGE_TRANSITIONS: Record<InvestorStage, InvestorStage[]> = {
  target: ["contacted", "lost", "passed"],
  contacted: ["meeting", "target", "lost", "passed"],
  meeting: ["diligence", "contacted", "lost", "passed"],
  diligence: ["term_sheet", "meeting", "lost", "passed"],
  term_sheet: ["won", "diligence", "lost", "passed"],
  won: [],
  lost: ["target"],
  passed: ["target"],
};

export function isLegalStageTransition(from: InvestorStage, to: InvestorStage): boolean {
  return from !== to && (STAGE_TRANSITIONS[from] ?? []).includes(to);
}

/** Human labels for the kanban columns (sentence case). */
export const STAGE_LABELS: Record<InvestorStage, string> = {
  target: "Target",
  contacted: "Contacted",
  meeting: "Meeting",
  diligence: "Diligence",
  term_sheet: "Term sheet",
  won: "Won",
  lost: "Lost",
  passed: "Passed",
};

export type EnrichmentSource = "self_reported" | "enriched";

export interface InvestorEnrichmentInput {
  firm?: string | null;
  title?: string | null;
  email?: string | null;
  checkSizeMin?: number | null;
  checkSizeMax?: number | null;
  stages?: string[];
  sectors?: string[];
  thesisFit?: string | null;
  /** v1 = manual entry. `enriched` requires fetchedAt (provider fetch). */
  enrichmentSource?: EnrichmentSource | null;
  enrichmentFetchedAt?: string | null; // ISO date string
  enrichmentNotes?: string | null;
}

/**
 * Pure validation for enrichment updates. v1 is manual/structured entry —
 * no live scraping — so the only hard rules are field sanity and the
 * enriched-requires-fetchedAt provenance rule.
 */
export function validateInvestorEnrichment(input: InvestorEnrichmentInput): string[] {
  const errors: string[] = [];
  if (input.email != null && input.email.trim() && !/^\S+@\S+\.\S+$/.test(input.email.trim())) {
    errors.push("email must be a valid email address.");
  }
  const min = input.checkSizeMin ?? null;
  const max = input.checkSizeMax ?? null;
  if (min != null && (!Number.isFinite(min) || min < 0)) {
    errors.push("checkSizeMin must be a non-negative number.");
  }
  if (max != null && (!Number.isFinite(max) || max < 0)) {
    errors.push("checkSizeMax must be a non-negative number.");
  }
  if (min != null && max != null && min > max) {
    errors.push("checkSizeMin cannot be larger than checkSizeMax.");
  }
  for (const s of input.stages ?? []) {
    if (!s.trim()) errors.push("stages cannot contain blank entries.");
  }
  for (const s of input.sectors ?? []) {
    if (!s.trim()) errors.push("sectors cannot contain blank entries.");
  }
  if (input.enrichmentSource === "enriched") {
    if (!input.enrichmentFetchedAt?.trim()) {
      errors.push(
        "enrichmentFetchedAt is required when enrichmentSource is enriched — enriched fields must carry a fetch timestamp.",
      );
    } else {
      const d = new Date(input.enrichmentFetchedAt);
      if (Number.isNaN(d.getTime())) {
        errors.push("enrichmentFetchedAt must be a valid date.");
      }
    }
  }
  return errors;
}

export type InteractionKind =
  | "email"
  | "call"
  | "meeting"
  | "intro"
  | "deck_sent"
  | "note"
  | "stage_change";

export const INTERACTION_KINDS: InteractionKind[] = [
  "email",
  "call",
  "meeting",
  "intro",
  "deck_sent",
  "note",
];

export interface InteractionInput {
  kind: InteractionKind;
  summary: string;
  occurredAt?: string | null; // ISO date string, defaults to now
  contactId?: string | null;
  /** stage_change is recorded by the transition path only — never manually. */
  actor?: string | null;
}

/** Pure validation for a logged interaction (not stage_change). */
export function validateInteractionInput(input: InteractionInput): string[] {
  const errors: string[] = [];
  if (!INTERACTION_KINDS.includes(input.kind as InteractionKind)) {
    errors.push(`kind must be one of: ${INTERACTION_KINDS.join(", ")}.`);
  }
  if (!input.summary?.trim()) {
    errors.push("summary is required — say what happened.");
  } else if (input.summary.trim().length > 2000) {
    errors.push("summary must be at most 2000 characters.");
  }
  if (input.occurredAt) {
    const d = new Date(input.occurredAt);
    if (Number.isNaN(d.getTime())) {
      errors.push("occurredAt must be a valid date.");
    } else if (d.getTime() > Date.now() + 5 * 60 * 1000) {
      errors.push("occurredAt cannot be in the future.");
    }
  }
  return errors;
}

export interface FollowUpInput {
  dueAt: string; // ISO date string
  note: string;
}

/** Pure validation for a follow-up reminder. */
export function validateFollowUpInput(input: FollowUpInput): string[] {
  const errors: string[] = [];
  if (!input.dueAt?.trim()) {
    errors.push("dueAt is required.");
  } else {
    const d = new Date(input.dueAt);
    if (Number.isNaN(d.getTime())) {
      errors.push("dueAt must be a valid date.");
    }
  }
  if (!input.note?.trim()) {
    errors.push("note is required — say what the follow-up is for.");
  }
  return errors;
}

export interface FundingInvestorView {
  id: string;
  name: string;
  firm: string | null;
  title: string | null;
  email: string | null;
  checkSizeMin: number | null;
  checkSizeMax: number | null;
  stages: string[];
  sectors: string[];
  thesisFit: string | null;
  enrichmentSource: EnrichmentSource;
  enrichmentFetchedAt: Date | null;
  enrichmentNotes: string | null;
  stage: InvestorStage;
  source: string | null;
  createdAt: Date;
}

export interface FundingInteractionView {
  id: string;
  occurredAt: Date;
  kind: InteractionKind;
  summary: string;
  actor: string | null;
  contactId: string | null;
  contactName: string | null;
  createdAt: Date;
}

export interface FundingFollowUpView {
  id: string;
  investorId: string;
  investorName: string;
  dueAt: Date;
  note: string;
  done: boolean;
  doneAt: Date | null;
  createdAt: Date;
}
