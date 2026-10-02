// Marketr — CAD + Hardware slice 2: natural-language design-request parsing.
// Spec: BUSINESS-OS-FEATURE-SPECS.md §2 slice 2. Reference customer: the
// autonomous drone platform build.
//
// THE PROPOSAL-EXECUTION BOUNDARY (v1): this module only PARSES a request
// into a structured, reviewable DesignChangeProposal. The AI proposes, the
// human approves — and even an approved proposal NEVER rewrites geometry in
// v1 (there is no code path that does). Approving marks the model
// "change requested"; the tenant carries the edit out in their CAD tool and
// publishes a new version.
//
// The parser is deliberately deterministic (keyword + measurement rules, no
// LLM in v1) so every parse is auditable and its confidence is honest.
// The proposal stays editable while draft — the human can fix the parse.

import { CadError } from "./types";

/** Structured operations v1 understands. "unrecognized" = recorded honestly. */
export const DESIGN_OPERATIONS = [
  "thicken_wall",
  "thin_wall",
  "add_hole",
  "remove_hole",
  "resize_feature",
  "move_feature",
  "fillet_edge",
  "chamfer_edge",
  "offset_surface",
  "smooth_region",
  "unrecognized",
] as const;

export type DesignOperation = (typeof DESIGN_OPERATIONS)[number];

export function isDesignOperation(v: string): v is DesignOperation {
  return (DESIGN_OPERATIONS as readonly string[]).includes(v);
}

export type ParseConfidence = "high" | "medium" | "low";

export interface ParsedDesignRequest {
  operation: DesignOperation;
  /** Normalized to millimetres, with an explicit unit marker. */
  parameters: Record<string, number | string>;
  /** The feature the request refers to ("this wall", "the left arm"). */
  featureLabel: string | null;
  /** Why, when the requester said why. */
  rationale: string | null;
  confidence: ParseConfidence;
  recognized: boolean;
}

const VERB_PATTERNS: { op: DesignOperation; re: RegExp }[] = [
  { op: "thicken_wall", re: /\b(thicken|make .* thicker|thicker|reinforce|beef up)\b/i },
  { op: "thin_wall", re: /\b(thin|make .* thinner|thinner|lighten)\b/i },
  { op: "add_hole", re: /\b(add|drill|bore|cut|punch|make).{0,20}\b(hole|opening|slot|port|vent)\b/i },
  { op: "remove_hole", re: /\b(fill|plug|close|remove).{0,20}\b(hole|opening|slot|port)\b/i },
  { op: "fillet_edge", re: /\b(fillet|round).{0,25}\b(edge|corner)s?\b/i },
  { op: "chamfer_edge", re: /\b(chamfer|bevel).{0,25}\b(edge|corner)s?\b/i },
  { op: "move_feature", re: /\b(move|shift|relocate|slide)\b/i },
  { op: "resize_feature", re: /\b(resize|scale|enlarge|shrink|bigger|smaller|longer|shorter|wider|narrower|taller|increase|decrease|reduce|extend)\b/i },
  { op: "offset_surface", re: /\b(offset)\b/i },
  { op: "smooth_region", re: /\b(smooth|smoothing)\b/i },
];

/** Feature nouns the parser can anchor a request to. */
const FEATURE_NOUNS =
  "wall|rib|hole|slot|boss|flange|arm|base|plate|edge|face|top|bottom|side|rim|lip|bracket|mount|frame|shell|skin|strut|spar|tab|notch|groove|pocket|channel|gusset|rail|post|pin|cavity|dome|cap|cover|housing|fuselage|wing|tail|prop|motor|battery|tray|lid|handle|knob|foot|leg|corner";

/** Qualifiers that pin a feature down ("this left wall"). */
const FEATURE_QUALIFIERS = "this|that|the|left|right|top|bottom|front|back|rear|upper|lower|inner|outer|main|front|side";

/** Extract the first measurement and normalize to mm. */
function extractMillimeters(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(mm|millimeters?|cm|centimeters?|in|inch(?:es)?|"|thou|mils?)?\b/i);
  if (!m) return null;
  const value = parseFloat(m[1]!);
  if (!Number.isFinite(value)) return null;
  const unit = (m[2] ?? "mm").toLowerCase();
  if (unit.startsWith("cm") || unit.startsWith("centimeter")) return value * 10;
  if (unit === "in" || unit.startsWith("inch") || unit === '"') return value * 25.4;
  if (unit.startsWith("thou") || unit.startsWith("mil")) return value * 0.0254;
  return value; // mm or unitless (assumed mm — labeled in the UI)
}

/** The feature noun nearest the matched verb, with qualifiers. */
function extractFeatureLabel(text: string): string | null {
  const re = new RegExp(
    `\\b(${FEATURE_QUALIFIERS})?\\s*(${FEATURE_NOUNS})s?\\b`,
    "i",
  );
  const m = text.match(re);
  if (!m) return null;
  const qualifier = m[1]?.toLowerCase();
  const noun = m[2]!.toLowerCase();
  return qualifier ? `${qualifier} ${noun}` : noun;
}

/** A "because / so that / to …" clause, trimmed to a sane length. */
function extractRationale(text: string): string | null {
  const m = text.match(/\b(because|so that|in order to|to make it|so|to)\b\s+(.{4,200})/i);
  if (!m) return null;
  const clause = m[2]!.replace(/[.!?]+$/, "").trim();
  return clause ? clause.slice(0, 240) : null;
}

function paramsFor(op: DesignOperation, mm: number | null): Record<string, number | string> {
  const p: Record<string, number | string> = { unit: "mm" };
  if (mm === null) return p;
  switch (op) {
    case "thicken_wall":
    case "thin_wall":
      p.targetThicknessMm = Math.round(mm * 100) / 100;
      break;
    case "add_hole":
      p.diameterMm = Math.round(mm * 100) / 100;
      break;
    case "fillet_edge":
      p.radiusMm = Math.round(mm * 100) / 100;
      break;
    case "chamfer_edge":
      p.distanceMm = Math.round(mm * 100) / 100;
      break;
    case "move_feature":
      p.distanceMm = Math.round(mm * 100) / 100;
      break;
    case "resize_feature":
      p.targetDimensionMm = Math.round(mm * 100) / 100;
      break;
    case "offset_surface":
      p.offsetMm = Math.round(mm * 100) / 100;
      break;
    default:
      break;
  }
  return p;
}

/**
 * Parse a natural-language edit request into a structured proposal draft.
 * Deterministic and auditable: keyword rules + measurement normalization.
 * Low-confidence parses are returned honestly — the human reviews and can
 * edit every field while the proposal is a draft.
 */
export function parseDesignRequest(text: string): ParsedDesignRequest {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new CadError("INVALID_REQUEST", "Describe the change you want — the request cannot be empty.");
  }
  if (trimmed.length > 2000) {
    throw new CadError("INVALID_REQUEST", "The request must be 2,000 characters or fewer.");
  }
  let operation: DesignOperation = "unrecognized";
  for (const { op, re } of VERB_PATTERNS) {
    if (re.test(trimmed)) {
      operation = op;
      break;
    }
  }
  const mm = extractMillimeters(trimmed);
  const featureLabel = extractFeatureLabel(trimmed);
  const rationale = extractRationale(trimmed);
  const recognized = operation !== "unrecognized";
  const confidence: ParseConfidence = !recognized
    ? "low"
    : mm !== null && featureLabel
      ? "high"
      : featureLabel || mm !== null
        ? "medium"
        : "low";
  return {
    operation,
    parameters: paramsFor(operation, mm),
    featureLabel,
    rationale,
    confidence,
    recognized,
  };
}

export interface ProposalDraftInput {
  /** The verbatim natural-language request. */
  requestedText: string;
  /** Optional 3D region the request refers to: {min:[x,y,z],max:[x,y,z]}. */
  targetRegion?: { min: [number, number, number]; max: [number, number, number] } | null;
}

export function validateTargetRegion(
  region: ProposalDraftInput["targetRegion"],
): void {
  if (region == null) return;
  const nums = [...region.min, ...region.max];
  if (nums.length !== 6 || !nums.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new CadError("INVALID_REGION", "The target region must be six finite numbers.");
  }
  for (let i = 0; i < 3; i++) {
    if (region.min[i] > region.max[i]) {
      throw new CadError("INVALID_REGION", "The region min must not exceed the region max on any axis.");
    }
  }
}
