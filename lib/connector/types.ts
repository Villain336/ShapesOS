// Marketr — Connector Agent slice 1: graph core types + warmth math.
// SPEC-CONNECTOR-AGENT.md §3/§6: Person, Company, Relationship, ImportBatch.
// Warmth is RECOMPUTED from interaction signals — never hand-set as the
// only signal. The pure function below is the single source of truth for
// the score; the store's recordTouch/recomputeAllWarmth are just plumbing
// that feeds it.

export class ConnectorError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Enums (mirror the Prisma enums).
// ---------------------------------------------------------------------------

export const CONNECTOR_COMPANY_SIZE_BANDS = [
  "solo",
  "startup",
  "smb",
  "midmarket",
  "enterprise",
] as const;
export type ConnectorCompanySizeBand =
  (typeof CONNECTOR_COMPANY_SIZE_BANDS)[number];

export const CONNECTOR_COMPANY_RELATIONSHIPS = [
  "customer",
  "prospect",
  "investor",
  "partner",
  "vendor",
] as const;
export type ConnectorCompanyRelationship =
  (typeof CONNECTOR_COMPANY_RELATIONSHIPS)[number];

export const CONNECTOR_IMPORT_SOURCES = [
  "manual",
  "csv",
  "email",
  "calendar",
  "boardy_starter",
] as const;
export type ConnectorImportSource = (typeof CONNECTOR_IMPORT_SOURCES)[number];

export const TOUCH_DIRECTIONS = ["inbound", "outbound"] as const;
export type TouchDirection = (typeof TOUCH_DIRECTIONS)[number];

// ---------------------------------------------------------------------------
// Warmth math — the documented weights.
//
//   warmth = recency (50) + frequency (30) + reciprocity (20)  →  0..100
//
// RECENCY (50 pts): days since the last recorded touch.
//   ≤ 7d → 50 · ≤ 30d → 35 · ≤ 90d → 20 · ≤ 180d → 10 · ≤ 365d → 5
//   > 365d or never touched → 0
// FREQUENCY (30 pts): total recorded touches (diminishing returns).
//   0 → 0 · 1 → 8 · 2 → 14 · 3–4 → 20 · 5–9 → 26 · ≥ 10 → 30
// RECIPROCITY (20 pts): share of touches that were INBOUND (they reached
// out to the tenant — the strongest warmth signal).
//   no touches → 0 · ≥ 50% → 20 · ≥ 33% → 14 · ≥ 20% → 8 · > 0% → 4 · 0% → 0
//
// Deterministic given (signals, now) — no wall-clock reads inside, so the
// sweep and the tests agree on every score.
// ---------------------------------------------------------------------------

export const WARMTH_WEIGHTS = { recency: 50, frequency: 30, reciprocity: 20 } as const;

/** [maxDaysExclusive, points] — first band whose maxDays exceeds the age wins. */
export const WARMTH_RECENCY_BANDS: Array<readonly [number, number]> = [
  [7, 50],
  [30, 35],
  [90, 20],
  [180, 10],
  [365, 5],
];

/** [minTouches, points] — highest band whose minTouches is met wins. */
export const WARMTH_FREQUENCY_BANDS: Array<readonly [number, number]> = [
  [10, 30],
  [5, 26],
  [3, 20],
  [2, 14],
  [1, 8],
];

/** [minInboundShare, points] — highest band whose share is met wins. */
export const WARMTH_RECIPROCITY_BANDS: Array<readonly [number, number]> = [
  [0.5, 20],
  [0.33, 14],
  [0.2, 8],
  [Number.MIN_VALUE, 4],
];

export interface WarmthSignals {
  lastTouchAt: Date | null;
  touchCount: number;
  inboundCount: number;
  outboundCount: number;
}

export interface WarmthBreakdown {
  recency: number;
  frequency: number;
  reciprocity: number;
  score: number;
}

export function computeWarmth(
  signals: WarmthSignals,
  now: Date,
): WarmthBreakdown {
  const touchCount = Math.max(0, Math.floor(signals.touchCount));

  // Recency.
  let recency = 0;
  if (signals.lastTouchAt && touchCount > 0) {
    const ageMs = now.getTime() - signals.lastTouchAt.getTime();
    if (ageMs >= 0) {
      const ageDays = ageMs / (24 * 60 * 60 * 1000);
      for (const [maxDays, points] of WARMTH_RECENCY_BANDS) {
        if (ageDays <= maxDays) {
          recency = points;
          break;
        }
      }
    }
  }

  // Frequency.
  let frequency = 0;
  for (const [minTouches, points] of WARMTH_FREQUENCY_BANDS) {
    if (touchCount >= minTouches) {
      frequency = points;
      break;
    }
  }

  // Reciprocity.
  let reciprocity = 0;
  if (touchCount > 0) {
    const inbound = Math.max(0, Math.min(signals.inboundCount, touchCount));
    const share = inbound / touchCount;
    if (share > 0) {
      for (const [minShare, points] of WARMTH_RECIPROCITY_BANDS) {
        if (share >= minShare) {
          reciprocity = points;
          break;
        }
      }
    }
  }

  const score = Math.min(
    100,
    recency + frequency + reciprocity,
  );
  return { recency, frequency, reciprocity, score };
}

// ---------------------------------------------------------------------------
// Input validation (pure).
// ---------------------------------------------------------------------------

export interface PersonInput {
  name?: unknown;
  roles?: unknown;
  handles?: unknown;
  importBatchId?: unknown;
  consentedBy?: unknown;
  consentedAt?: unknown;
}

export interface ValidPersonInput {
  name: string;
  roles: string[];
  handles: string[];
  importBatchId: string | null;
  consentedBy: string;
  consentedAt: Date;
}

function asStringArray(value: unknown, field: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) return [`__ERR__${field} must be an array`];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string" || !v.trim()) {
      return [`__ERR__${field} must contain only non-empty strings`];
    }
    out.push(v.trim());
  }
  return out;
}

export function validatePersonInput(input: PersonInput): {
  errors: string[];
  value: ValidPersonInput | null;
} {
  const errors: string[] = [];
  const name =
    typeof input.name === "string" ? input.name.trim() : "";
  if (!name) errors.push("name is required.");
  if (name.length > 200) errors.push("name must be 200 characters or fewer.");

  const roles = asStringArray(input.roles, "roles");
  const handles = asStringArray(input.handles, "handles");
  for (const arr of [roles, handles]) {
    const err = arr.find((s) => s.startsWith("__ERR__"));
    if (err) errors.push(err.slice("__ERR__".length));
  }

  // Provenance is mandatory: every Person records whose consent brought it in.
  const consentedBy =
    typeof input.consentedBy === "string" ? input.consentedBy.trim() : "";
  if (!consentedBy) errors.push("consentedBy is required (provenance).");

  let consentedAt: Date | null = null;
  if (input.consentedAt == null) {
    consentedAt = new Date();
  } else {
    const d = new Date(input.consentedAt as string);
    if (Number.isNaN(d.getTime())) errors.push("consentedAt must be a valid date.");
    else consentedAt = d;
  }

  const importBatchId =
    input.importBatchId == null
      ? null
      : typeof input.importBatchId === "string" && input.importBatchId.trim()
        ? input.importBatchId.trim()
        : null;
  if (input.importBatchId != null && importBatchId == null) {
    errors.push("importBatchId must be a non-empty string when provided.");
  }

  if (errors.length > 0) return { errors, value: null };
  return {
    errors,
    value: {
      name,
      roles: roles.filter((s) => !s.startsWith("__ERR__")),
      handles: handles.filter((s) => !s.startsWith("__ERR__")),
      importBatchId,
      consentedBy,
      consentedAt: consentedAt as Date,
    },
  };
}

export interface CompanyInput {
  name?: unknown;
  industry?: unknown;
  sizeBand?: unknown;
  relationship?: unknown;
}

export interface ValidCompanyInput {
  name: string;
  industry: string | null;
  sizeBand: ConnectorCompanySizeBand | null;
  relationship: ConnectorCompanyRelationship | null;
}

export function validateCompanyInput(input: CompanyInput): {
  errors: string[];
  value: ValidCompanyInput | null;
} {
  const errors: string[] = [];
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) errors.push("name is required.");
  if (name.length > 200) errors.push("name must be 200 characters or fewer.");

  const industry =
    input.industry == null
      ? null
      : typeof input.industry === "string" && input.industry.trim()
        ? input.industry.trim()
        : null;
  if (input.industry != null && typeof input.industry !== "string") {
    errors.push("industry must be a string.");
  }

  let sizeBand: ConnectorCompanySizeBand | null = null;
  if (input.sizeBand != null) {
    if (
      typeof input.sizeBand === "string" &&
      (CONNECTOR_COMPANY_SIZE_BANDS as readonly string[]).includes(input.sizeBand)
    ) {
      sizeBand = input.sizeBand as ConnectorCompanySizeBand;
    } else {
      errors.push(
        `sizeBand must be one of: ${CONNECTOR_COMPANY_SIZE_BANDS.join(", ")}.`,
      );
    }
  }

  let relationship: ConnectorCompanyRelationship | null = null;
  if (input.relationship != null) {
    if (
      typeof input.relationship === "string" &&
      (CONNECTOR_COMPANY_RELATIONSHIPS as readonly string[]).includes(
        input.relationship,
      )
    ) {
      relationship = input.relationship as ConnectorCompanyRelationship;
    } else {
      errors.push(
        `relationship must be one of: ${CONNECTOR_COMPANY_RELATIONSHIPS.join(", ")}.`,
      );
    }
  }

  if (errors.length > 0) return { errors, value: null };
  return { errors, value: { name, industry, sizeBand, relationship } };
}

export interface ImportBatchInput {
  source?: unknown;
  consentedBy?: unknown;
  consentedAt?: unknown;
  note?: unknown;
}

export interface ValidImportBatchInput {
  source: ConnectorImportSource;
  consentedBy: string;
  consentedAt: Date;
  note: string | null;
}

export function validateImportBatchInput(input: ImportBatchInput): {
  errors: string[];
  value: ValidImportBatchInput | null;
} {
  const errors: string[] = [];
  let source: ConnectorImportSource = "manual";
  if (input.source != null) {
    if (
      typeof input.source === "string" &&
      (CONNECTOR_IMPORT_SOURCES as readonly string[]).includes(input.source)
    ) {
      source = input.source as ConnectorImportSource;
    } else {
      errors.push(
        `source must be one of: ${CONNECTOR_IMPORT_SOURCES.join(", ")}.`,
      );
    }
  }
  // Consent gating: no batch without a recorded consenter.
  const consentedBy =
    typeof input.consentedBy === "string" ? input.consentedBy.trim() : "";
  if (!consentedBy) errors.push("consentedBy is required — no import without recorded consent.");

  let consentedAt: Date | null = null;
  if (input.consentedAt == null) {
    consentedAt = new Date();
  } else {
    const d = new Date(input.consentedAt as string);
    if (Number.isNaN(d.getTime())) errors.push("consentedAt must be a valid date.");
    else consentedAt = d;
  }

  const note =
    input.note == null
      ? null
      : typeof input.note === "string" && input.note.trim()
        ? input.note.trim()
        : null;
  if (input.note != null && typeof input.note !== "string") {
    errors.push("note must be a string.");
  }

  if (errors.length > 0) return { errors, value: null };
  return {
    errors,
    value: { source, consentedBy, consentedAt: consentedAt as Date, note },
  };
}

export interface TouchInput {
  personId?: unknown;
  direction?: unknown;
  at?: unknown;
}

export interface ValidTouchInput {
  personId: string;
  direction: TouchDirection;
  at: Date;
}

export function validateTouchInput(input: TouchInput): {
  errors: string[];
  value: ValidTouchInput | null;
} {
  const errors: string[] = [];
  const personId =
    typeof input.personId === "string" ? input.personId.trim() : "";
  if (!personId) errors.push("personId is required.");

  let direction: TouchDirection | null = null;
  if (
    typeof input.direction === "string" &&
    (TOUCH_DIRECTIONS as readonly string[]).includes(input.direction)
  ) {
    direction = input.direction as TouchDirection;
  } else {
    errors.push(`direction must be one of: ${TOUCH_DIRECTIONS.join(", ")}.`);
  }

  let at = new Date();
  if (input.at != null) {
    const d = new Date(input.at as string);
    if (Number.isNaN(d.getTime())) errors.push("at must be a valid date.");
    else at = d;
  }

  if (errors.length > 0) return { errors, value: null };
  return { errors, value: { personId, direction: direction as TouchDirection, at } };
}

export interface EmploymentInput {
  personId?: unknown;
  companyId?: unknown;
  title?: unknown;
  startYear?: unknown;
  endYear?: unknown;
  isCurrent?: unknown;
}

export interface ValidEmploymentInput {
  personId: string;
  companyId: string;
  title: string | null;
  startYear: number | null;
  endYear: number | null;
  isCurrent: boolean;
}

export function validateEmploymentInput(input: EmploymentInput): {
  errors: string[];
  value: ValidEmploymentInput | null;
} {
  const errors: string[] = [];
  const personId =
    typeof input.personId === "string" ? input.personId.trim() : "";
  if (!personId) errors.push("personId is required.");
  const companyId =
    typeof input.companyId === "string" ? input.companyId.trim() : "";
  if (!companyId) errors.push("companyId is required.");

  const title =
    input.title == null
      ? null
      : typeof input.title === "string" && input.title.trim()
        ? input.title.trim()
        : null;
  if (input.title != null && typeof input.title !== "string") {
    errors.push("title must be a string.");
  }

  const year = (v: unknown, field: string): number | null => {
    if (v == null) return null;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isInteger(n) || n < 1900 || n > 2100) {
      errors.push(`${field} must be a year between 1900 and 2100.`);
      return null;
    }
    return n;
  };
  const startYear = year(input.startYear, "startYear");
  const endYear = year(input.endYear, "endYear");
  if (startYear != null && endYear != null && endYear < startYear) {
    errors.push("endYear must not be before startYear.");
  }

  const isCurrent = input.isCurrent == null ? true : input.isCurrent === true;

  if (errors.length > 0) return { errors, value: null };
  return {
    errors,
    value: { personId, companyId, title, startYear, endYear, isCurrent },
  };
}

export interface RelationshipPatchInput {
  notes?: unknown;
  boundaries?: unknown;
}

export function validateRelationshipPatch(input: RelationshipPatchInput): {
  errors: string[];
  value: { notes: string | null; boundaries: string | null } | null;
} {
  const errors: string[] = [];
  const clean = (v: unknown, field: string): string | null => {
    if (v == null) return null;
    if (typeof v !== "string") {
      errors.push(`${field} must be a string.`);
      return null;
    }
    return v.trim() ? v.trim() : null;
  };
  const notes = clean(input.notes, "notes");
  const boundaries = clean(input.boundaries, "boundaries");
  if (errors.length > 0) return { errors, value: null };
  return { errors, value: { notes, boundaries } };
}

// ---------------------------------------------------------------------------
// View types (what the store returns / the API serializes).
// ---------------------------------------------------------------------------

export interface ConnectorRelationshipView {
  id: string;
  personId: string;
  warmthScore: number;
  warmthComputedAt: Date | null;
  warmthBreakdown: WarmthBreakdown;
  lastTouchAt: Date | null;
  touchCount: number;
  inboundCount: number;
  outboundCount: number;
  lastReciprocalTouchAt: Date | null;
  notes: string | null;
  boundaries: string | null;
  updatedAt: Date;
}

export interface ConnectorEmploymentView {
  id: string;
  companyId: string;
  companyName: string;
  companyIndustry: string | null;
  companySizeBand: ConnectorCompanySizeBand | null;
  companyRelationship: ConnectorCompanyRelationship | null;
  title: string | null;
  startYear: number | null;
  endYear: number | null;
  isCurrent: boolean;
}

export interface ConnectorImportBatchView {
  id: string;
  source: ConnectorImportSource;
  consentedBy: string;
  consentedAt: Date;
  note: string | null;
  personCount: number;
  createdAt: Date;
}

export interface ConnectorPersonView {
  id: string;
  name: string;
  roles: string[];
  handles: string[];
  importBatchId: string | null;
  importBatch: ConnectorImportBatchView | null;
  consentedBy: string;
  consentedAt: Date;
  relationship: ConnectorRelationshipView | null;
  employments: ConnectorEmploymentView[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectorCompanyView {
  id: string;
  name: string;
  industry: string | null;
  sizeBand: ConnectorCompanySizeBand | null;
  relationship: ConnectorCompanyRelationship | null;
  employeeCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectorGraphView {
  persons: ConnectorPersonView[];
  companies: ConnectorCompanyView[];
  batches: ConnectorImportBatchView[];
}
