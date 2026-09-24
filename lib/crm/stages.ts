// Marketr — Lead Pipeline CRM: stage machine + scoring rules v1.
//
// Scoring is deterministic and documented here (rules v1). scoreFor() is a
// pure function of the inputs so the battery can assert determinism; the
// route layer calls recomputeScore() which persists the result and logs a
// score_change activity only when the lead crosses a score band.

export interface CrmStage {
  id: string;
  label: string;
  /** Badge color key consumed by the UI (StageBadge). */
  color: "violet" | "blue" | "teal" | "amber" | "green" | "gray" | "red";
}

/** Default stage machine for a new pipeline (agency white-label default). */
export const DEFAULT_STAGES: CrmStage[] = [
  { id: "new", label: "New", color: "violet" },
  { id: "contacted", label: "Contacted", color: "blue" },
  { id: "qualified", label: "Qualified", color: "teal" },
  { id: "proposal", label: "Proposal", color: "amber" },
  { id: "won", label: "Won", color: "green" },
  { id: "lost", label: "Lost", color: "gray" },
];

/** Stages that close the lead — excluded from the active-lead meter. */
export const CLOSED_STAGES = new Set(["won", "lost"]);

export function isClosedStage(stageId: string): boolean {
  return CLOSED_STAGES.has(stageId);
}

/** Parse and validate a stages JSON value from the Pipeline row. */
export function parseStages(raw: unknown): CrmStage[] {
  if (!Array.isArray(raw)) throw new Error("stages must be an array");
  return raw.map((s, i) => {
    if (typeof s !== "object" || s === null) throw new Error(`stage[${i}] invalid`);
    const r = s as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id.trim()) throw new Error(`stage[${i}].id required`);
    if (typeof r.label !== "string" || !r.label.trim()) throw new Error(`stage[${i}].label required`);
    return { id: r.id.trim(), label: r.label.trim(), color: validColor(r.color) };
  });
}

function validColor(c: unknown): CrmStage["color"] {
  const ok = ["violet", "blue", "teal", "amber", "green", "gray", "red"] as const;
  return ok.includes(c as CrmStage["color"]) ? (c as CrmStage["color"]) : "gray";
}

export function stageIds(stages: CrmStage[]): string[] {
  return stages.map((s) => s.id);
}

/**
 * Validate a candidate stage set for pipeline create/update. The canonical
 * closed stages (won/lost) are required so the meter and forecast agree;
 * duplicate ids would corrupt stage filters and the kanban.
 */
export function validateStageSet(stages: CrmStage[]): void {
  const ids = stageIds(stages);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`duplicate stage id: ${id}`);
    seen.add(id);
  }
  if (!seen.has("won") || !seen.has("lost")) {
    throw new Error("stages must include won and lost");
  }
}

/** Score bands used by filters, the forecast weighting, and score_change logging. */
export type ScoreBand = "cold" | "warm" | "hot";
export function scoreBand(score: number): ScoreBand {
  if (score >= 70) return "hot";
  if (score >= 40) return "warm";
  return "cold";
}

// ── Scoring rules v1 ─────────────────────────────────────────────────────
// Deterministic, explainable, no ML. Documented so agencies can quote it:
//
//   base by source:  referral 50 · phone 45 · website_form 40 · ad 30 ·
//                    direct_mail 30 · ooh 25 · import 20 · other 20
//   contact completeness: +10 email · +10 phone · +5 company
//   recency (of lastActivityAt): +15 ≤7d · +8 ≤30d · +0 older
//   engagement: +2 per logged activity (cap +10), excluding system types
//   clamped to 0–100.

const SOURCE_BASE: Record<string, number> = {
  referral: 50,
  phone: 45,
  website_form: 40,
  ad: 30,
  direct_mail: 30,
  ooh: 25,
  import: 20,
  other: 20,
};

const ENGAGEMENT_TYPES = new Set(["note", "email", "call", "sms", "meeting", "form_submit"]);

export interface ScoreInputs {
  source: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  lastActivityAt?: Date | null;
  engagementCount?: number;
  now?: Date;
}

export function scoreFor(i: ScoreInputs): { score: number; band: ScoreBand; reasons: string[] } {
  const now = i.now ?? new Date();
  const reasons: string[] = [];
  let s = SOURCE_BASE[i.source] ?? SOURCE_BASE.other;
  reasons.push(`source ${i.source}: +${s}`);

  if (i.email) { s += 10; reasons.push("has email: +10"); }
  if (i.phone) { s += 10; reasons.push("has phone: +10"); }
  if (i.company) { s += 5; reasons.push("has company: +5"); }

  if (i.lastActivityAt) {
    const ageDays = (now.getTime() - i.lastActivityAt.getTime()) / 86_400_000;
    if (ageDays <= 7) { s += 15; reasons.push("active ≤7d: +15"); }
    else if (ageDays <= 30) { s += 8; reasons.push("active ≤30d: +8"); }
  }

  const eng = Math.min(10, (i.engagementCount ?? 0) * 2);
  if (eng > 0) { s += eng; reasons.push(`engagement ×${i.engagementCount ?? 0}: +${eng}`); }

  s = Math.max(0, Math.min(100, s));
  return { score: s, band: scoreBand(s), reasons };
}
