// Marketr — Funding/VC slice 4: Round readiness domain (pure).
// Spec: BUSINESS-OS-FEATURE-SPECS.md §3 (Round readiness — checklist:
// incorporation, cap table, SAFE templates via the Legal feature §4, plus
// AI pitch-deck review against known investor patterns).
//
// This module is pure: no DB, no I/O. Pass `now` explicitly in tests.
//
// Design notes:
// - The checklist's 7 keys are fixed (CHECKLIST_KEYS). Statuses are manual:
//   the founder owns the checklist; the store only enforces the transition
//   rules below (done sets completedAt; waived requires a reason).
// - incorporation / ein items carry a read-only cross-link into the Legal
//   feature (LegalDocument docTypes "formation" / "ein_letter"). The cross-
//   link is READ-ONLY: this feature never writes Legal rows — it only reads
//   them for readiness signals (see getReadinessSignals in the store).
// - Cap-table rollups are pure bigint functions: total fully-diluted shares,
//   per-type percentages (founder / investor / employee / advisor), top
//   holder. Percentages are returned as basis points + formatted strings so
//   callers never float-divide large share counts.
// - v1 cap table is manual entry — no live Carta sync.

import { FundingError } from "./types";

export const CHECKLIST_KEYS = [
  "incorporation",
  "ein",
  "cap_table",
  "safe_template",
  "pitch_deck",
  "financials",
  "data_room_links",
] as const;

export type ChecklistKey = (typeof CHECKLIST_KEYS)[number];

export const CHECKLIST_STATUSES = ["todo", "doing", "done", "waived"] as const;

export type ChecklistStatus = (typeof CHECKLIST_STATUSES)[number];

export function isChecklistKey(value: unknown): value is ChecklistKey {
  return (
    typeof value === "string" &&
    (CHECKLIST_KEYS as readonly string[]).includes(value)
  );
}

export function isChecklistStatus(value: unknown): value is ChecklistStatus {
  return (
    typeof value === "string" &&
    (CHECKLIST_STATUSES as readonly string[]).includes(value)
  );
}

export interface ChecklistTemplateEntry {
  key: ChecklistKey;
  label: string;
  description: string;
  /** Legal feature cross-link hint (read-only): which LegalDocument docTypes
   * back this item. Null = no Legal backing. */
  legalDocTypes: ("formation" | "ein_letter")[] | null;
  /** Data-room doc kind that backs this item. Null = no data-room backing. */
  dataRoomKind: "pitch_deck" | "financials" | null;
}

/**
 * The canonical 7-item round-readiness checklist. The store seeds one row
 * per (round, key) on first readiness read; labels/descriptions live here so
 * the schema stores only keys.
 */
export const READINESS_CHECKLIST_TEMPLATE: ChecklistTemplateEntry[] = [
  {
    key: "incorporation",
    label: "Incorporation documents filed",
    description:
      "Articles of incorporation / certificate of formation on file in the legal vault.",
    legalDocTypes: ["formation"],
    dataRoomKind: null,
  },
  {
    key: "ein",
    label: "EIN obtained",
    description:
      "Employer Identification Number (IRS confirmation letter) on file.",
    legalDocTypes: ["ein_letter"],
    dataRoomKind: null,
  },
  {
    key: "cap_table",
    label: "Cap table complete",
    description:
      "Every stakeholder entered with share counts and class — the fully-diluted math must tie out.",
    legalDocTypes: null,
    dataRoomKind: null,
  },
  {
    key: "safe_template",
    label: "SAFE template selected",
    description:
      "Pick the standard SAFE variant that matches this round (valuation cap, discount, or MFN). Templates are general information, not legal advice.",
    legalDocTypes: null,
    dataRoomKind: null,
  },
  {
    key: "pitch_deck",
    label: "Pitch deck in data room",
    description: "Current pitch deck uploaded as the data room's pitch_deck document.",
    legalDocTypes: null,
    dataRoomKind: "pitch_deck",
  },
  {
    key: "financials",
    label: "Financials current",
    description: "Up-to-date financials uploaded as the data room's financials document.",
    legalDocTypes: null,
    dataRoomKind: "financials",
  },
  {
    key: "data_room_links",
    label: "Data-room links tested",
    description:
      "Every investor-facing share link verified: not revoked, not expired, resolves to the right version.",
    legalDocTypes: null,
    dataRoomKind: null,
  },
];

/** Evidence-link shapes stored on checklist items. */
export interface ChecklistEvidenceLink {
  label: string;
  url?: string;
  legalDocumentId?: string;
  dataRoomDocId?: string;
  shareLinkId?: string;
}

export interface ChecklistEvidence {
  links: ChecklistEvidenceLink[];
  safeTemplateKey?: string;
  safeTemplateParams?: Record<string, string | number | null>;
  testedAt?: string;
  note?: string;
}

export function emptyEvidence(): ChecklistEvidence {
  return { links: [] };
}

/**
 * Validate a status transition + payload for a checklist item update.
 * Rules:
 * - Any status may move to any other status (the founder owns the list).
 * - `done` requires nothing extra; the store stamps completedAt/completedBy.
 * - Moving OFF `done` clears the completion stamp.
 * - `waived` REQUIRES a reason (notes non-empty) — a waived item without a
 *   reason is not a decision, it's a hole.
 * - Evidence links: at most 20, each needs a label and at least one target.
 */
export function validateChecklistItemUpdate(input: {
  status?: unknown;
  notes?: unknown;
  evidence?: unknown;
}): { status?: ChecklistStatus; notes?: string | null; evidence?: ChecklistEvidence } {
  const out: {
    status?: ChecklistStatus;
    notes?: string | null;
    evidence?: ChecklistEvidence;
  } = {};

  if (input.status !== undefined) {
    if (!isChecklistStatus(input.status)) {
      throw new FundingError(
        "INVALID_STATUS",
        `status must be one of: ${CHECKLIST_STATUSES.join(", ")}.`,
      );
    }
    out.status = input.status;
  }

  if (input.notes !== undefined) {
    if (input.notes !== null && typeof input.notes !== "string") {
      throw new FundingError("INVALID_NOTES", "notes must be a string or null.");
    }
    const notes = typeof input.notes === "string" ? input.notes.trim() : null;
    if (notes !== null && notes.length > 2000) {
      throw new FundingError("INVALID_NOTES", "notes must be 2000 characters or fewer.");
    }
    if (out.status === "waived" && !notes) {
      throw new FundingError(
        "WAIVE_NEEDS_REASON",
        "Waiving a checklist item requires a reason — put it in notes.",
      );
    }
    out.notes = notes;
  } else if (out.status === "waived") {
    // Waiving without touching notes is allowed only if the caller keeps an
    // existing reason — the store enforces that against the current row.
    out.notes = undefined;
  }

  if (input.evidence !== undefined) {
    out.evidence = validateChecklistEvidence(input.evidence);
  }

  return out;
}

export function validateChecklistEvidence(value: unknown): ChecklistEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FundingError("INVALID_EVIDENCE", "evidence must be an object.");
  }
  const v = value as Record<string, unknown>;
  const linksRaw = v.links ?? [];
  if (!Array.isArray(linksRaw)) {
    throw new FundingError("INVALID_EVIDENCE", "evidence.links must be an array.");
  }
  if (linksRaw.length > 20) {
    throw new FundingError("INVALID_EVIDENCE", "evidence.links holds at most 20 links.");
  }
  const links: ChecklistEvidenceLink[] = linksRaw.map((l, i) => {
    if (l === null || typeof l !== "object" || Array.isArray(l)) {
      throw new FundingError("INVALID_EVIDENCE", `evidence.links[${i}] must be an object.`);
    }
    const link = l as Record<string, unknown>;
    const label = typeof link.label === "string" ? link.label.trim() : "";
    if (!label) {
      throw new FundingError("INVALID_EVIDENCE", `evidence.links[${i}].label is required.`);
    }
    if (label.length > 200) {
      throw new FundingError("INVALID_EVIDENCE", `evidence.links[${i}].label is too long.`);
    }
    const url = typeof link.url === "string" && link.url.trim() ? link.url.trim() : undefined;
    const legalDocumentId =
      typeof link.legalDocumentId === "string" && link.legalDocumentId.trim()
        ? link.legalDocumentId.trim()
        : undefined;
    const dataRoomDocId =
      typeof link.dataRoomDocId === "string" && link.dataRoomDocId.trim()
        ? link.dataRoomDocId.trim()
        : undefined;
    const shareLinkId =
      typeof link.shareLinkId === "string" && link.shareLinkId.trim()
        ? link.shareLinkId.trim()
        : undefined;
    if (!url && !legalDocumentId && !dataRoomDocId && !shareLinkId) {
      throw new FundingError(
        "INVALID_EVIDENCE",
        `evidence.links[${i}] needs a target: url, legalDocumentId, dataRoomDocId, or shareLinkId.`,
      );
    }
    if (url && !/^https?:\/\//i.test(url)) {
      throw new FundingError("INVALID_EVIDENCE", `evidence.links[${i}].url must be http(s).`);
    }
    return { label, url, legalDocumentId, dataRoomDocId, shareLinkId };
  });

  const out: ChecklistEvidence = { links };
  if (v.safeTemplateKey !== undefined) {
    if (typeof v.safeTemplateKey !== "string" || !v.safeTemplateKey.trim()) {
      throw new FundingError("INVALID_EVIDENCE", "evidence.safeTemplateKey must be a non-empty string.");
    }
    out.safeTemplateKey = v.safeTemplateKey.trim();
  }
  if (v.safeTemplateParams !== undefined) {
    if (v.safeTemplateParams === null || typeof v.safeTemplateParams !== "object" || Array.isArray(v.safeTemplateParams)) {
      throw new FundingError("INVALID_EVIDENCE", "evidence.safeTemplateParams must be an object.");
    }
    out.safeTemplateParams = v.safeTemplateParams as Record<string, string | number | null>;
  }
  if (v.testedAt !== undefined) {
    if (typeof v.testedAt !== "string" || Number.isNaN(Date.parse(v.testedAt))) {
      throw new FundingError("INVALID_EVIDENCE", "evidence.testedAt must be an ISO date string.");
    }
    out.testedAt = v.testedAt;
  }
  if (v.note !== undefined) {
    if (typeof v.note !== "string") {
      throw new FundingError("INVALID_EVIDENCE", "evidence.note must be a string.");
    }
    out.note = v.note.slice(0, 1000);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cap table (pure rollups)
// ---------------------------------------------------------------------------

export const STAKEHOLDER_TYPES = ["founder", "investor", "employee", "advisor"] as const;

export type StakeholderType = (typeof STAKEHOLDER_TYPES)[number];

export function isStakeholderType(value: unknown): value is StakeholderType {
  return (
    typeof value === "string" &&
    (STAKEHOLDER_TYPES as readonly string[]).includes(value)
  );
}

export interface StakeholderInput {
  name?: unknown;
  type?: unknown;
  shares?: unknown;
  shareClass?: unknown;
  vestingSummary?: unknown;
  notes?: unknown;
}

export interface ValidatedStakeholder {
  name: string;
  type: StakeholderType;
  /** Share count as bigint — counts can exceed 2^31. */
  shares: bigint;
  shareClass: string | null;
  vestingSummary: string | null;
  notes: string | null;
}

function toBigintShares(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new FundingError("INVALID_SHARES", "shares must be a whole number of shares.");
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new FundingError("INVALID_SHARES", "shares must be a non-negative whole number.");
}

/** Validate a cap-table stakeholder row (create or patch). */
export function validateStakeholderInput(input: StakeholderInput): ValidatedStakeholder {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new FundingError("INVALID_NAME", "Stakeholder name is required.");
  if (name.length > 200) throw new FundingError("INVALID_NAME", "Name must be 200 characters or fewer.");
  if (!isStakeholderType(input.type)) {
    throw new FundingError(
      "INVALID_TYPE",
      `type must be one of: ${STAKEHOLDER_TYPES.join(", ")}.`,
    );
  }
  const shares = toBigintShares(input.shares);
  if (shares < BigInt(0)) throw new FundingError("INVALID_SHARES", "shares cannot be negative.");

  const opt = (v: unknown, max: number, field: string): string | null => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") throw new FundingError("INVALID_INPUT", `${field} must be a string.`);
    const t = v.trim();
    if (t.length > max) throw new FundingError("INVALID_INPUT", `${field} must be ${max} characters or fewer.`);
    return t || null;
  };

  return {
    name,
    type: input.type,
    shares,
    shareClass: opt(input.shareClass, 120, "shareClass"),
    vestingSummary: opt(input.vestingSummary, 300, "vestingSummary"),
    notes: opt(input.notes, 2000, "notes"),
  };
}

export interface CapTableRow {
  id: string;
  name: string;
  type: StakeholderType;
  shares: bigint;
  shareClass: string | null;
  vestingSummary: string | null;
}

export interface CapTableRollup {
  /** Total fully-diluted shares across all rows. */
  totalShares: bigint;
  /** Shares per stakeholder type. */
  byType: Record<StakeholderType, bigint>;
  /** Fully-diluted % per stakeholder type, in basis points (10000 = 100%). */
  pctByTypeBp: Record<StakeholderType, number>;
  /** Per-row fully-diluted %, in basis points, same order as input rows. */
  rowPctBp: number[];
  /** Largest single holder (null when no rows). */
  topHolder: { name: string; shares: bigint; pctBp: number } | null;
  rowCount: number;
}

/**
 * Pure fully-diluted rollup. Basis points keep the math exact on bigint
 * share counts: pctBp = shares * 10000 / total. An empty table rolls up to
 * zeros (never NaN, never a divide-by-zero).
 */
export function rollupCapTable(rows: CapTableRow[]): CapTableRollup {
  const byType: Record<StakeholderType, bigint> = {
    founder: BigInt(0),
    investor: BigInt(0),
    employee: BigInt(0),
    advisor: BigInt(0),
  };
  let total = BigInt(0);
  for (const r of rows) {
    total += r.shares;
    byType[r.type] += r.shares;
  }
  const bp = (part: bigint): number =>
    total === BigInt(0) ? 0 : Number((part * BigInt(10000)) / total);

  const pctByTypeBp: Record<StakeholderType, number> = {
    founder: bp(byType.founder),
    investor: bp(byType.investor),
    employee: bp(byType.employee),
    advisor: bp(byType.advisor),
  };

  const rowPctBp = rows.map((r) => bp(r.shares));

  let topHolder: CapTableRollup["topHolder"] = null;
  rows.forEach((r, i) => {
    if (!topHolder || r.shares > topHolder.shares) {
      topHolder = { name: r.name, shares: r.shares, pctBp: rowPctBp[i] };
    }
  });

  return { totalShares: total, byType, pctByTypeBp, rowPctBp, topHolder, rowCount: rows.length };
}

/** "12.34%" from basis points. */
export function formatPctBp(bp: number): string {
  return `${(bp / 100).toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// View types (what the API serializes; bigint shares cross as strings)
// ---------------------------------------------------------------------------

export interface ChecklistItemView {
  id: string;
  roundId: string;
  key: ChecklistKey;
  label: string;
  description: string;
  status: ChecklistStatus;
  evidence: ChecklistEvidence;
  notes: string | null;
  completedAt: Date | null;
  completedBy: string | null;
  /** Read-only Legal vault cross-link targets for this item's template entry. */
  legalDocTypes: ("formation" | "ein_letter")[] | null;
  dataRoomKind: "pitch_deck" | "financials" | null;
}

export interface StakeholderView {
  id: string;
  roundId: string;
  name: string;
  type: StakeholderType;
  shares: string;
  shareClass: string | null;
  vestingSummary: string | null;
  notes: string | null;
  /** Fully-diluted %, basis points, against the round's current rollup. */
  fullyDilutedPctBp: number;
}

export interface ReadinessSignals {
  /** Read-only Legal vault: formation/EIN docs present for this tenant. */
  legalVault: {
    formationDocs: { id: string; title: string }[];
    einDocs: { id: string; title: string }[];
  };
  dataRoom: {
    pitchDeck: { docId: string; title: string; version: number } | null;
    financials: { docId: string; title: string; version: number } | null;
    shareLinks: { total: number; tested: number };
  };
  capTable: {
    rowCount: number;
    totalShares: string;
    founderPctBp: number;
    investorPctBp: number;
  };
  deckReview: { id: string; overallScore: number; createdAt: Date } | null;
}
