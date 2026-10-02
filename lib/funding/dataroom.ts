// Marketr — Funding/VC slice 3: Data room domain (pure).
// Spec: BUSINESS-OS-FEATURE-SPECS.md §3 (Data room — versioned pitch deck,
// financials, metrics; shareable with expiring links; per-viewer analytics
// "who opened what, when").
//
// This module is pure: no DB, no I/O. Pass `now` explicitly in tests.
//
// docType: the slice-1 FundingDataRoomDoc.kind enum (pitch_deck /
// financials / metrics / other) already carries the spec's docType values,
// so no new enum was introduced — the existing field IS the docType.
//
// Versioning rule (hard): a new upload is ALWAYS a new version row linked
// to the prior one. Published version rows are never mutated — the store
// exposes no update path for versions; the doc's currentVersion pointer
// just moves forward.
//
// Share-link rules (hard):
// - Expiry is enforced at ACCESS time (resolveShareLink), not at creation.
// - A revoked link behaves as gone (404 at the public route).
// - An allowlisted link requires the viewer email to match, case-insensitive.
// - The token is unguessable (fsr_ + 128 bits) and never logged.

import { createHash, randomBytes } from "node:crypto";
import { FundingError } from "./types";

export const DATA_ROOM_DOC_KINDS = [
  "pitch_deck",
  "financials",
  "metrics",
  "other",
] as const;

export type DataRoomDocKind = (typeof DATA_ROOM_DOC_KINDS)[number];

export function isValidDataRoomDocKind(
  value: unknown,
): value is DataRoomDocKind {
  return (
    typeof value === "string" &&
    (DATA_ROOM_DOC_KINDS as readonly string[]).includes(value)
  );
}

export const DATA_ROOM_KIND_LABELS: Record<DataRoomDocKind, string> = {
  pitch_deck: "Pitch deck",
  financials: "Financials",
  metrics: "Metrics",
  other: "Other",
};

/** Pure validation for a new data-room doc. Returns errors. */
export function validateDocInput(input: {
  title?: unknown;
  kind?: unknown;
  notes?: unknown;
}): string[] {
  const errors: string[] = [];
  if (typeof input.title !== "string" || !input.title.trim()) {
    errors.push("Title is required.");
  } else if (input.title.trim().length > 200) {
    errors.push("Title must be 200 characters or fewer.");
  }
  if (!isValidDataRoomDocKind(input.kind)) {
    errors.push(
      `kind must be one of: ${DATA_ROOM_DOC_KINDS.join(", ")}.`,
    );
  }
  if (input.notes !== undefined && input.notes !== null) {
    if (typeof input.notes !== "string") {
      errors.push("notes must be a string.");
    } else if (input.notes.length > 2000) {
      errors.push("notes must be 2000 characters or fewer.");
    }
  }
  return errors;
}

/** The version row a new upload supersedes (null = brand-new document). */
export interface PreviousDocVersion {
  id: string;
  versionNumber: number;
}

/**
 * A new upload of the same logical document is ALWAYS a new version row —
 * history is never overwritten. Version 1 for a new document; otherwise
 * previous.versionNumber + 1, superseding the previous version. The file
 * for every version is written to a version-distinct path, so an old
 * version's bytes can never be replaced in place either.
 */
export function planNewDocVersion(previous: PreviousDocVersion | null): {
  versionNumber: number;
  supersedesVersionId: string | null;
} {
  return {
    versionNumber: previous ? previous.versionNumber + 1 : 1,
    supersedesVersionId: previous?.id ?? null,
  };
}

/** Token prefix for share links. Never log the token itself. */
export const SHARE_TOKEN_PREFIX = "fsr_";

/** Generate an unguessable share token: fsr_ + 128 random bits. */
export function generateShareToken(): string {
  return `${SHARE_TOKEN_PREFIX}${randomBytes(16).toString("hex")}`;
}

/** Max viewer emails on one allowlist — bounded so the column stays sane. */
export const MAX_SHARE_VIEWER_EMAILS = 50;

/** Upper bound on link lifetime (2 years) — a guardrail, not a default. */
export const MAX_SHARE_EXPIRY_DAYS = 730;

export interface ShareLinkInput {
  /** null = whole-room link. */
  docId?: string | null;
  /** Pinned version; null = resolve to the doc's current version at access. */
  docVersionId?: string | null;
  expiresAt?: string | null;
  viewerEmails?: string[] | null;
}

/** Pure validation for share-link creation. Returns errors. */
export function validateShareLinkInput(
  input: ShareLinkInput,
  now = new Date(),
): string[] {
  const errors: string[] = [];
  if (input.docId !== undefined && input.docId !== null) {
    if (typeof input.docId !== "string" || !input.docId.trim()) {
      errors.push("docId must be a non-empty string or null.");
    }
  }
  if (input.docVersionId !== undefined && input.docVersionId !== null) {
    if (typeof input.docVersionId !== "string" || !input.docVersionId.trim()) {
      errors.push("docVersionId must be a non-empty string or null.");
    }
  }
  if (input.docId === null && input.docVersionId) {
    errors.push("docVersionId is meaningless on a whole-room link.");
  }
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    const d = new Date(input.expiresAt);
    if (Number.isNaN(d.getTime())) {
      errors.push("expiresAt must be a valid date.");
    } else if (d.getTime() <= now.getTime()) {
      errors.push("expiresAt must be in the future.");
    } else if (
      d.getTime() - now.getTime() >
      MAX_SHARE_EXPIRY_DAYS * 24 * 60 * 60 * 1000
    ) {
      errors.push(
        `expiresAt cannot be more than ${MAX_SHARE_EXPIRY_DAYS} days out.`,
      );
    }
  }
  if (input.viewerEmails !== undefined && input.viewerEmails !== null) {
    if (!Array.isArray(input.viewerEmails)) {
      errors.push("viewerEmails must be an array.");
    } else {
      if (input.viewerEmails.length > MAX_SHARE_VIEWER_EMAILS) {
        errors.push(
          `viewerEmails cannot exceed ${MAX_SHARE_VIEWER_EMAILS} entries.`,
        );
      }
      const bad = input.viewerEmails.filter(
        (e) => typeof e !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()),
      );
      if (bad.length > 0) errors.push("viewerEmails must be valid emails.");
    }
  }
  return errors;
}

export interface ShareLinkForAccess {
  revoked: boolean;
  expiresAt: Date | null;
  viewerEmails: string[];
}

/** Why a share link cannot be served. */
export type ShareAccessFailure =
  | "link_revoked"
  | "link_expired"
  | "email_required"
  | "email_not_allowlisted";

/**
 * Enforce share-link access rules at access time. Pure — the route maps a
 * failure to 404 (revoked/expired, so revoked links look gone) or 403
 * (email gate). Pass `now` explicitly in tests.
 */
export function resolveShareLink(
  link: ShareLinkForAccess,
  params: { email?: string | null },
  now = new Date(),
): { ok: true } | { ok: false; failure: ShareAccessFailure } {
  if (link.revoked) return { ok: false, failure: "link_revoked" };
  if (link.expiresAt && link.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, failure: "link_expired" };
  }
  if (link.viewerEmails.length > 0) {
    const email = params.email?.trim().toLowerCase();
    if (!email) return { ok: false, failure: "email_required" };
    const allow = link.viewerEmails.map((e) => e.trim().toLowerCase());
    if (!allow.includes(email)) {
      return { ok: false, failure: "email_not_allowlisted" };
    }
  }
  return { ok: true };
}

/**
 * Viewer identity for analytics (spec §3: "who opened what, when").
 * An allowlisted email when the viewer supplied one; otherwise a
 * fingerprint hash of network + UA. No cookies, no third-party tracking.
 */
export function viewerIdentityFor(params: {
  email?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): string {
  const email = params.email?.trim();
  if (email) return email;
  const h = createHash("sha256");
  h.update(`${params.ip ?? "unknown"}|${params.userAgent ?? "unknown"}`);
  return `fp:${h.digest("hex").slice(0, 16)}`;
}

/** Normalize the viewer-email allowlist (trim, dedupe, lowercase). */
export function normalizeViewerEmails(emails: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of emails) {
    const e = raw.trim().toLowerCase();
    if (e && !seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}

// ------------------------------------------------------------------
// View types (shared between the store, APIs, and UI).
// ------------------------------------------------------------------

export interface FundingDocVersionView {
  id: string;
  versionNumber: number;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  uploadedBy: string;
  uploadedAt: Date;
  isCurrent: boolean;
  supersedesVersionId: string | null;
  viewCount: number;
}

export interface FundingShareLinkView {
  id: string;
  /** null = whole room. */
  docId: string | null;
  docTitle: string | null;
  docVersionId: string | null;
  pinnedVersionNumber: number | null;
  /** The public URL path (token redacted from all other surfaces). */
  urlPath: string;
  expiresAt: Date | null;
  expired: boolean;
  viewerEmails: string[];
  revoked: boolean;
  viewCount: number;
  createdAt: Date;
}

export interface FundingDocViewRow {
  id: string;
  linkId: string;
  /** null = whole-room link. */
  docId: string | null;
  docTitle: string | null;
  docVersionNumber: number | null;
  viewerIdentity: string;
  userAgent: string | null;
  durationMs: number | null;
  openedAt: Date;
}

export interface FundingDataRoomDocView {
  id: string;
  title: string;
  kind: DataRoomDocKind;
  notes: string | null;
  currentVersion: FundingDocVersionView | null;
  versionCount: number;
  shareLinkCount: number;
  viewCount: number;
  createdAt: Date;
}

export interface ShareLinkCreateInput {
  docId: string | null;
  docVersionId: string | null;
  expiresAt: string | null;
  viewerEmails: string[];
}

/** Assert non-empty upload bytes before writing anything. */
export function assertNonEmptyUpload(bytes: Buffer): void {
  if (!bytes || bytes.length === 0) {
    throw new FundingError("EMPTY_FILE", "Attach a file — it cannot be empty.");
  }
}
