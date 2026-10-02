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
