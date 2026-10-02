// Marketr — CAD + Hardware slice 1: CAD viewer + versioning domain types.
// Spec: BUSINESS-OS-FEATURE-SPECS.md §2. Reference customer: the autonomous
// drone platform build (drone airframe parts are the model use case).
//
// Hard guardrails (never bend):
// 1. STEP has no native three.js loader and is NOT faked — STEP versions
//    always report previewAvailable = false and the UI labels the state
//    truthfully ("preview unavailable for STEP — conversion pending").
// 2. Diff numbers are computed from actual geometry or marked unavailable —
//    never invented. Triangle deltas, bounding-box deltas and the mesh-volume
//    estimate come from the real parsers in geometry.ts; when a side cannot
//    be parsed, the diff row records availability "unavailable".
// 3. Share links are fail-closed: unknown, revoked, or expired tokens resolve
//    to LINK_NOT_FOUND / LINK_REVOKED / LINK_EXPIRED — the public surface
//    404s all three.
// 4. Everything is tenant-scoped (workspaceId on every row and every query).

import { randomBytes } from "node:crypto";

/** CAD model formats slice 1 accepts. */
export const CAD_FORMATS = [
  { value: "stl", label: "STL" },
  { value: "obj", label: "OBJ" },
  { value: "step", label: "STEP" },
] as const;

export type CadFormat = (typeof CAD_FORMATS)[number]["value"];

export function isCadFormat(v: string): v is CadFormat {
  return CAD_FORMATS.some((f) => f.value === v);
}

export function formatLabel(format: CadFormat): string {
  return CAD_FORMATS.find((f) => f.value === format)?.label ?? format;
}

/**
 * Preview truth table. three.js renders STL and OBJ natively via
 * examples/jsm loaders; STEP has no loader, so a STEP version NEVER claims
 * a rendered preview. The one honest exception to add later would be a real
 * STEP→mesh conversion (e.g. OpenCASCADE wasm) — until then, conversion is
 * "pending", never faked.
 */
export function previewAvailableForFormat(format: CadFormat): boolean {
  return format === "stl" || format === "obj";
}

export const STEP_PREVIEW_MESSAGE =
  "Preview unavailable for STEP — conversion pending. Upload an STL or OBJ export of this model to preview it in the browser.";

export class CadError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.code = code;
  }
}

/** Upload caps mirror the existing filesystem pipeline (25 MB). */
export const CAD_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Share-link policy (mirrors funding data-room: required expiry, 730d cap). */
export const SHARE_LINK_DEFAULT_EXPIRY_DAYS = 14;
export const SHARE_LINK_MAX_EXPIRY_DAYS = 730;
export const SHARE_LINK_TOKEN_PREFIX = "cadsl_";

export function generateShareToken(): string {
  return SHARE_LINK_TOKEN_PREFIX + randomBytes(16).toString("hex");
}

export interface ProjectInput {
  name: string;
  description?: string | null;
}

export function validateProjectInput(input: ProjectInput): void {
  const name = input.name?.trim() ?? "";
  if (!name) throw new CadError("INVALID_NAME", "Project name is required.");
  if (name.length > 120)
    throw new CadError("INVALID_NAME", "Project name must be 120 characters or fewer.");
  if ((input.description?.length ?? 0) > 2000)
    throw new CadError(
      "INVALID_DESCRIPTION",
      "Description must be 2,000 characters or fewer.",
    );
}

export interface ModelInput {
  name: string;
  description?: string | null;
}

export function validateModelInput(input: ModelInput): void {
  const name = input.name?.trim() ?? "";
  if (!name) throw new CadError("INVALID_NAME", "Model name is required.");
  if (name.length > 120)
    throw new CadError("INVALID_NAME", "Model name must be 120 characters or fewer.");
}

export interface VersionInput {
  fileName: string;
  fileBytes: Buffer;
  notes?: string | null;
}

export function validateVersionInput(input: VersionInput): void {
  if (!input.fileName?.trim())
    throw new CadError("MISSING_FILE", "Attach a model file.");
  if (!input.fileBytes || input.fileBytes.length === 0)
    throw new CadError("EMPTY_FILE", "Attach a file — it cannot be empty.");
  if (input.fileBytes.length > CAD_MAX_FILE_BYTES)
    throw new CadError(
      "TOO_LARGE",
      `Model file exceeds the ${CAD_MAX_FILE_BYTES / (1024 * 1024)} MB cap.`,
    );
  if ((input.notes?.length ?? 0) > 2000)
    throw new CadError("INVALID_NOTES", "Notes must be 2,000 characters or fewer.");
}

export interface ShareLinkInput {
  /** null = link resolves to the model's current version at access time. */
  pinnedVersionId?: string | null;
  expiresInDays?: number | null;
  label?: string | null;
}

export function validateShareLinkInput(input: ShareLinkInput): void {
  const days = input.expiresInDays ?? SHARE_LINK_DEFAULT_EXPIRY_DAYS;
  if (!Number.isInteger(days) || days < 1)
    throw new CadError("INVALID_EXPIRY", "Expiry must be at least 1 day.");
  if (days > SHARE_LINK_MAX_EXPIRY_DAYS)
    throw new CadError(
      "INVALID_EXPIRY",
      `Expiry cannot exceed ${SHARE_LINK_MAX_EXPIRY_DAYS} days.`,
    );
  if ((input.label?.length ?? 0) > 120)
    throw new CadError("INVALID_LABEL", "Link label must be 120 characters or fewer.");
}

export function shareLinkExpiry(expiresInDays?: number | null): Date {
  const days = expiresInDays ?? SHARE_LINK_DEFAULT_EXPIRY_DAYS;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

/** Diff availability: "computed" only when both sides yielded real stats. */
export type DiffAvailability = "computed" | "unavailable";

/** Minimal per-version geometry snapshot fed into diff computation. */
export interface VersionGeometrySnapshot {
  versionId: string;
  versionNumber: number;
  triangleCount: number | null;
  bboxMin: [number, number, number] | null;
  bboxMax: [number, number, number] | null;
  volumeEstimate: number | null;
}

export interface ModelDiffResult {
  availability: DiffAvailability;
  triangleDelta: number | null;
  /** Per-axis size delta (to − from), null when either side lacks a bbox. */
  sizeDelta: [number, number, number] | null;
  /** Euclidean distance between bbox centers, null when unavailable. */
  centerDelta: number | null;
  volumeFrom: number | null;
  volumeTo: number | null;
  volumeDelta: number | null;
}
