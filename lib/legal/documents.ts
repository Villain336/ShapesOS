// Marketr — Legal/Compliance slice 3: document vault (pure).
// Spec: BUSINESS-OS-FEATURE-SPECS.md §4 (document vault).
//
// Formation docs, contracts, licenses, EIN letters — versioned, with
// expiring-document alerts. The expiry ladder is the SAME escalation ladder
// as slice 2's deadline engine (90/30/7 days, overdue, escalating severity);
// expiry alerts ride the same alert hub as a new trigger.
//
// HARD GUARDRAIL — never invent expiry dates:
//   * An expiry date is only ever tenant-set ("tenant_set") or read by the
//     tenant from the document itself ("read_from_document") — recorded on
//     the version, never guessed by the engine.
//   * A version with no expiry is tier "date_needed" and the alert copy asks
//     the tenant to record one — it never substitutes a calendar date.
//
// This module is pure: no DB, no I/O. Pass `now` explicitly in tests.

import {
  daysUntilDue,
  tierForDeadline,
  TIER_META,
  type EscalationTier,
} from "./deadlines";
import { LegalError } from "./types";

export {
  daysUntilDue,
  tierForDeadline as tierForExpiry,
  TIER_META,
};

/** Document kinds in the vault (spec §4: formation docs, contracts,
 *  licenses, EIN letters — plus policy/other). */
export const DOCUMENT_TYPES = [
  "formation",
  "contract",
  "license",
  "ein_letter",
  "policy",
  "other",
] as const;

export type LegalDocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<LegalDocumentType, string> = {
  formation: "Formation document",
  contract: "Contract",
  license: "License",
  ein_letter: "EIN letter",
  policy: "Policy",
  other: "Other",
};

export function isValidDocumentType(
  value: unknown,
): value is LegalDocumentType {
  return (
    typeof value === "string" &&
    (DOCUMENT_TYPES as readonly string[]).includes(value)
  );
}

/** Where a version's expiry date came from. The engine never invents one. */
export const EXPIRY_SOURCES = ["tenant_set", "read_from_document"] as const;

export type LegalExpirySource = (typeof EXPIRY_SOURCES)[number];

export const EXPIRY_SOURCE_LABELS: Record<LegalExpirySource, string> = {
  tenant_set: "Set by you",
  read_from_document: "Read from the document",
};

export function isValidExpirySource(
  value: unknown,
): value is LegalExpirySource {
  return value === "tenant_set" || value === "read_from_document";
}

/** A document's expiry tier — the same escalation ladder as deadlines. */
export type ExpiryTier = EscalationTier;

/**
 * Sentence-case alert title for a document version at a tier. Carries no
 * date the tenant did not set — the only dates rendered are tenant-set or
 * tenant-read dates.
 */
export function documentAlertTitle(
  title: string,
  tier: ExpiryTier,
): string {
  switch (tier) {
    case "date_needed":
      return `Record an expiry date: ${title}`;
    case "due_90":
      return `${title} — expires within 90 days`;
    case "due_30":
      return `${title} — expires within 30 days`;
    case "due_7":
      return `${title} — expires within 7 days`;
    case "overdue":
      return `${title} — expired`;
  }
}

/**
 * Sentence-case alert body. `expiryDateText` must be a tenant-confirmed or
 * tenant-read date string, or null (in which case the body asks the tenant
 * to record one — never substitutes a guess).
 */
export function documentAlertBody(params: {
  title: string;
  tier: ExpiryTier;
  expiryDateText: string | null;
  daysUntil: number | null;
}): string {
  const { title, tier, expiryDateText, daysUntil } = params;
  if (tier === "date_needed") {
    return (
      `"${title}" has no recorded expiry date yet. Read it from the document ` +
      `and record it in Legal → Documents so expiry reminders can be scheduled. ` +
      `Expiry dates are never guessed — this reminder appears only because you own this document.`
    );
  }
  if (tier === "overdue") {
    return (
      `"${title}" is past its expiry date${expiryDateText ? ` (${expiryDateText})` : ""}. ` +
      `Review it in Legal → Documents and confirm what is still valid.`
    );
  }
  const daysText =
    daysUntil === 0
      ? "today"
      : daysUntil === 1
        ? "tomorrow"
        : `in ${daysUntil} days`;
  return (
    `"${title}" expires ${daysText}${expiryDateText ? ` (${expiryDateText})` : ""}. ` +
    `Review it in Legal → Documents.`
  );
}

// ------------------------------------------------------------------
// Version-chain logic (pure). The Prisma store delegates to these so the
// versioning rules are unit-testable without a database.
// ------------------------------------------------------------------

/** The version row a new upload supersedes (null = brand-new document). */
export interface PreviousVersion {
  id: string;
  versionNumber: number;
  /** ISO expiry or null. */
  expiryDate: string | null;
  expirySource: LegalExpirySource | null;
  issuer: string | null;
}

/**
 * A new upload of the same logical document is ALWAYS a new version row —
 * history is never overwritten. Version 1 for a new document; otherwise
 * previous.versionNumber + 1, superseding the previous version.
 */
export function planNewVersion(previous: PreviousVersion | null): {
  versionNumber: number;
  supersedesVersionId: string | null;
} {
  return {
    versionNumber: previous ? previous.versionNumber + 1 : 1,
    supersedesVersionId: previous?.id ?? null,
  };
}

export interface VersionExpiryInput {
  /** undefined = not provided by this upload; null = explicitly cleared. */
  expiryDate?: string | null;
  expirySource?: LegalExpirySource | null;
}

/**
 * Expiry carry-forward for a new version. undefined expiryDate carries the
 * previous version's expiry forward; an explicit null clears it; a provided
 * date sets it (source = provided source, else the previous source, else
 * tenant_set). Unparseable dates are rejected. Guardrail: a date appears
 * only when the tenant provided it — there is no invented-date path.
 */
export function carryForwardExpiry(
  input: VersionExpiryInput,
  previous: PreviousVersion | null,
): { expiryDate: string | null; expirySource: LegalExpirySource | null } {
  if (input.expirySource !== undefined && input.expirySource !== null) {
    if (!isValidExpirySource(input.expirySource)) {
      throw new LegalError(
        "INVALID_EXPIRY_SOURCE",
        "expirySource must be tenant_set or read_from_document.",
      );
    }
  }
  if (input.expiryDate === undefined) {
    return {
      expiryDate: previous?.expiryDate ?? null,
      expirySource: previous?.expirySource ?? null,
    };
  }
  if (input.expiryDate === null || input.expiryDate === "") {
    return { expiryDate: null, expirySource: null };
  }
  const d = new Date(input.expiryDate);
  if (Number.isNaN(d.getTime())) {
    throw new LegalError("INVALID_DATE", "expiryDate must be a valid date.");
  }
  return {
    expiryDate: d.toISOString(),
    expirySource:
      input.expirySource ?? previous?.expirySource ?? "tenant_set",
  };
}
