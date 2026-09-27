// Marketr — Creative Studio: mail/print creative service (Phase 4, T2).
//
// VERSIONING MODEL (documented, per spec): new row per version. versionCreative
// copies the latest row into a NEW row with version+1 and marks the prior row
// "archived". Creative rows are immutable once superseded — the C3 approval
// gate binds a specific row's creativeHash, so a version bump can never
// silently change what an approval covered.
//
// CREATIVE HASH: SHA-256 over the exact stored PDF bytes (the "canonical"
// bytes). Same bytes -> same hash, always. Producers must store first, then
// hash — the hash is computed inside setCreativePdf over what was written.
//
// CHANNEL TEMPLATES: the "print" channel is live in v1. "email"/"social" are
// registered in lib/studio/formats.ts as coming_soon: creatives may be created
// as drafts under them, but format validation and mark-ready stay gated until
// their tracks are defined — no rework needed to plug them in later.

import { createHash } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { auditStudio } from "./service";
import {
  getFormatTrack,
  getSizeSpec,
  isRangeSize,
  ptToIn,
  type ChannelTemplateId,
  type FormatTrack,
} from "./formats";

/** Re-exported for route modules that type against the creative service. */
export type { ChannelTemplateId };

type Db = PrismaClient;
type Actor = "user" | "system";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Service error with an HTTP status the routes can map directly. */
export class CreativeHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CreativeHttpError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Creative hash — stable, deterministic
// ---------------------------------------------------------------------------

/** SHA-256 hex of the canonical PDF bytes. Same bytes -> same hash. */
export function computeCreativeHash(pdfBytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(pdfBytes).digest("hex");
}

// ---------------------------------------------------------------------------
// Lightweight PDF inspection (no pdf-lib dependency)
//
// Best-effort parse of the PDF header: page size from the first /MediaBox and
// page count from the /Pages /Count. Works on PDFs with plain (uncompressed)
// page trees — which covers most print-ready PDFs. Returns
// nulls for linearized/compressed-object PDFs; validation treats that as a
// soft "could not determine" issue rather than a hard failure.
// ---------------------------------------------------------------------------

export interface PdfInfo {
  isPdf: boolean;
  /** Page count, when readable. */
  pages: number | null;
  /** First-page trim size in inches, when readable. */
  widthIn: number | null;
  heightIn: number | null;
}

export function parsePdfInfo(bytes: Buffer | Uint8Array): PdfInfo {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const isPdf = buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-";
  if (!isPdf) return { isPdf: false, pages: null, widthIn: null, heightIn: null };
  let text: string;
  try {
    // Page-tree dictionaries live in the first chunk of a normal PDF; cap the
    // scan at 256 KB so we never slurp a 25 MB file into a string.
    text = buf.subarray(0, Math.min(buf.length, 256 * 1024)).toString("latin1");
  } catch {
    return { isPdf: true, pages: null, widthIn: null, heightIn: null };
  }
  let widthIn: number | null = null;
  let heightIn: number | null = null;
  const mb = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(text);
  if (mb) {
    const x1 = Number(mb[1]);
    const y1 = Number(mb[2]);
    const x2 = Number(mb[3]);
    const y2 = Number(mb[4]);
    if ([x1, y1, x2, y2].every((n) => Number.isFinite(n)) && x2 > x1 && y2 > y1) {
      widthIn = ptToIn(x2 - x1);
      heightIn = ptToIn(y2 - y1);
    }
  }
  let pages: number | null = null;
  const counts: number[] = [];
  const re = /\/Count\s+(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0 && n <= 10000) counts.push(n);
  }
  if (counts.length > 0) pages = Math.max(...counts);
  return { isPdf: true, pages, widthIn, heightIn };
}

// ---------------------------------------------------------------------------
// Format validation (THE critical validator)
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  severity: "error" | "warning" | "info";
  message: string;
}

export interface ValidationAttestation {
  noGovernmentImpersonation: true;
  attestedBy: string | null;
  attestedAt: string;
}

export interface ValidationReport {
  ok: boolean;
  channelTemplate: ChannelTemplateId;
  formatTrack: string;
  size: string;
  widthIn: number | null;
  heightIn: number | null;
  pages: number | null;
  issues: ValidationIssue[];
  /** Print-production notes. */
  printNotes: string[];
  attestation: ValidationAttestation | null;
  /** Workspace filesystem file id of the validated PDF (set by setCreativePdf). */
  fileId: string | null;
  validatedAt: string;
}

const FIXED_TRIM_TOLERANCE_IN = 0.02; // exact-trim match window
const BLEED_WARN_OVER_IN = 0.375; // beyond this over trim => warning (likely bleed)

function issuesOk(issues: ValidationIssue[]): boolean {
  return !issues.some((i) => i.severity === "error");
}

/**
 * Validate PDF bytes against a format track + size. THE spec hard constraint:
 * a 4x6 postcard PDF is REJECTED for the eddm track with an explicit error —
 * EDDM flats require a minimum of 6.125" x 11.5".
 *
 * For coming_soon channel templates (email/social), validation is a no-op
 * that returns ok with an info note — drafts can exist, mark-ready stays gated.
 */
export function validateFormat(
  channelTemplate: ChannelTemplateId,
  formatTrackId: string,
  sizeId: string,
  pdfBytes: Buffer | Uint8Array | null,
  opts?: { source?: string },
): ValidationReport {
  const base: ValidationReport = {
    ok: true,
    channelTemplate,
    formatTrack: formatTrackId,
    size: sizeId,
    widthIn: null,
    heightIn: null,
    pages: null,
    issues: [],
    printNotes: [],
    attestation: null,
    fileId: null,
    validatedAt: new Date().toISOString(),
  };

  if (channelTemplate !== "print") {
    base.issues.push({
      severity: "info",
      message: `Validation rules for the "${channelTemplate}" channel template are not defined yet (coming soon) — this creative stays a draft.`,
    });
    return base;
  }

  const track: FormatTrack | null = getFormatTrack("print", formatTrackId);
  if (!track) {
    base.ok = false;
    base.issues.push({ severity: "error", message: `Unknown format track "${formatTrackId}".` });
    return base;
  }
  const size = getSizeSpec(track, sizeId);
  if (!size) {
    base.ok = false;
    base.issues.push({ severity: "error", message: `Unknown size "${sizeId}" for track "${track.label}".` });
    return base;
  }

  if (!pdfBytes || pdfBytes.length === 0) {
    base.issues.push({
      severity: "info",
      message: "No PDF stored yet — validation will run when the PDF is uploaded.",
    });
    return base;
  }

  const info = parsePdfInfo(pdfBytes);
  if (!info.isPdf) {
    base.ok = false;
    base.issues.push({ severity: "error", message: "The uploaded file is not a PDF (%PDF- header missing)." });
    return base;
  }
  base.widthIn = info.widthIn;
  base.heightIn = info.heightIn;
  base.pages = info.pages;

  if (info.widthIn == null || info.heightIn == null) {
    // Dimensions are load-bearing for print validation (EDDM bounds, trim
    // tolerance): an unreadable-dimensions PDF fails, not warns.
    base.ok = false;
    base.issues.push({
      severity: "error",
      message:
        "Could not read page dimensions from the PDF (compressed object stream or linearized PDF). " +
        "Re-export with readable page boxes and re-upload — size checks cannot run without dimensions.",
    });
  } else if (isRangeSize(size)) {
    // Range size (EDDM flat): check short/long sides against USPS bounds.
    const shortSide = Math.min(info.widthIn, info.heightIn);
    const longSide = Math.max(info.widthIn, info.heightIn);
    const belowMin =
      shortSide < (size.minShortSideIn ?? 0) - FIXED_TRIM_TOLERANCE_IN ||
      longSide < (size.minLongSideIn ?? 0) - FIXED_TRIM_TOLERANCE_IN;
    const aboveMax =
      shortSide > (size.maxShortSideIn ?? 0) + FIXED_TRIM_TOLERANCE_IN ||
      longSide > (size.maxLongSideIn ?? 0) + FIXED_TRIM_TOLERANCE_IN;
    if (belowMin) {
      base.ok = false;
      // The spec's hard constraint, worded for the UI:
      base.issues.push({
        severity: "error",
        message:
          `EDDM flats require a minimum of 6.125″ × 11.5″ — this PDF is ${info.widthIn.toFixed(2)}″ × ${info.heightIn.toFixed(2)}″. ` +
          "A 4×6 postcard does NOT qualify for EDDM (USPS minimum). Use the Addressed track for 4×6 postcards.",
      });
    }
    if (aboveMax) {
      base.ok = false;
      base.issues.push({
        severity: "error",
        message:
          `EDDM flats may be no larger than 12″ × 15″ — this PDF is ${info.widthIn.toFixed(2)}″ × ${info.heightIn.toFixed(2)}″.`,
      });
    }
  } else {
    // Fixed trim: match within tolerance; bleed-sized PDFs get a warning.
    const dw = Math.abs(info.widthIn - size.widthIn);
    const dh = Math.abs(info.heightIn - size.heightIn);
    // Allow either orientation for "any" sizes by comparing both rotations.
    const dwRot = Math.abs(info.widthIn - size.heightIn);
    const dhRot = Math.abs(info.heightIn - size.widthIn);
    const exact =
      (dw <= FIXED_TRIM_TOLERANCE_IN && dh <= FIXED_TRIM_TOLERANCE_IN) ||
      (size.orientation === "any" && dwRot <= FIXED_TRIM_TOLERANCE_IN && dhRot <= FIXED_TRIM_TOLERANCE_IN);
    if (!exact) {
      const overW = info.widthIn - size.widthIn;
      const overH = info.heightIn - size.heightIn;
      const likelyBleed =
        overW >= 0 && overH >= 0 && overW <= BLEED_WARN_OVER_IN && overH <= BLEED_WARN_OVER_IN;
      if (likelyBleed) {
        base.issues.push({
          severity: "warning",
          message:
            `PDF is ${info.widthIn.toFixed(2)}″ × ${info.heightIn.toFixed(2)}″ vs trim ${size.widthIn}″ × ${size.heightIn}″ — ` +
            "likely includes print bleed. Trim size matches after bleed; confirm with your printer.",
        });
      } else {
        base.ok = false;
        base.issues.push({
          severity: "error",
          message:
            `PDF is ${info.widthIn.toFixed(2)}″ × ${info.heightIn.toFixed(2)}″ but "${size.label}" requires ${size.widthIn}″ × ${size.heightIn}″ trim.`,
        });
      }
    }
    if (size.orientation === "portrait" && info.heightIn < info.widthIn) {
      base.issues.push({
        severity: "warning",
        message: `"${size.label}" expects portrait orientation — this PDF is landscape.`,
      });
    }
  }

  if (info.pages != null) {
    if (info.pages < size.minPages || info.pages > size.maxPages) {
      base.ok = false;
      base.issues.push({
        severity: "error",
        message: `"${size.label}" allows ${size.minPages}–${size.maxPages} page(s); this PDF has ${info.pages}.`,
      });
    }
  } else {
    base.issues.push({
      severity: "info",
      message: "Page count could not be read from the PDF — page checks were skipped.",
    });
  }

  return base;
}

// ---------------------------------------------------------------------------
// DB row helpers (all workspace-scoped)
// ---------------------------------------------------------------------------

export type CreativeSource = "upload";
export type CreativeStatus = "draft" | "ready" | "archived";

function serialize(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    name: String(row.name),
    channelTemplate: String(row.channelTemplate) as ChannelTemplateId,
    formatTrack: String(row.formatTrack),
    size: String(row.size),
    source: String(row.source) as CreativeSource,
    pdfUrl: (row.pdfUrl as string | null) ?? null,
    creativeHash: (row.creativeHash as string | null) ?? null,
    version: Number(row.version),
    status: String(row.status) as CreativeStatus,
    validation: (row.validation as ValidationReport | null) ?? null,
    createdAt: (row.createdAt as Date).toISOString(),
    updatedAt: (row.updatedAt as Date).toISOString(),
  };
}

export type Creative = ReturnType<typeof serialize>;

export async function listCreatives(
  db: Db,
  workspaceId: string,
  filters?: { channelTemplate?: string; formatTrack?: string; status?: string; q?: string },
): Promise<Creative[]> {
  const rows = await db.mailCreative.findMany({
    where: {
      workspaceId,
      ...(filters?.channelTemplate ? { channelTemplate: filters.channelTemplate } : {}),
      ...(filters?.formatTrack ? { formatTrack: filters.formatTrack } : {}),
      ...(filters?.status ? { status: filters.status } : {}),
      ...(filters?.q ? { name: { contains: filters.q, mode: "insensitive" } } : {}),
    },
    orderBy: [{ updatedAt: "desc" }],
    take: 200,
  });
  return rows.map((r) => serialize(r as unknown as Record<string, unknown>));
}

export async function getCreative(db: Db, workspaceId: string, id: string): Promise<Creative | null> {
  const row = await db.mailCreative.findFirst({ where: { id, workspaceId } });
  return row ? serialize(row as unknown as Record<string, unknown>) : null;
}

export interface CreateCreativeInput {
  name: string;
  channelTemplate?: ChannelTemplateId;
  formatTrack: string;
  size: string;
  source?: CreativeSource;
  createdBy?: string;
}

export async function createCreative(
  db: Db,
  workspaceId: string,
  input: CreateCreativeInput,
  actor: Actor = "user",
): Promise<Creative> {
  const name = input.name.trim();
  if (!name) throw new CreativeHttpError(400, "Creative name is required.");
  const channelTemplate: ChannelTemplateId = input.channelTemplate ?? "print";
  if (!["print", "email", "social"].includes(channelTemplate)) {
    throw new CreativeHttpError(400, `Unknown channel template "${channelTemplate}".`);
  }
  if (channelTemplate === "print") {
    const track = getFormatTrack("print", input.formatTrack);
    if (!track) throw new CreativeHttpError(400, `Unknown format track "${input.formatTrack}".`);
    if (!getSizeSpec(track, input.size)) {
      throw new CreativeHttpError(400, `Unknown size "${input.size}" for track "${track.label}".`);
    }
  }
  const source: CreativeSource = input.source ?? "upload";
  if (source !== "upload") {
    throw new CreativeHttpError(400, `Unknown source "${source}".`);
  }
  const validation = validateFormat(channelTemplate, input.formatTrack, input.size, null, { source });
  const row = await db.mailCreative.create({
    data: {
      workspaceId,
      name,
      channelTemplate,
      formatTrack: input.formatTrack,
      size: input.size,
      source,
      validation: validation as unknown as object,
      createdBy: input.createdBy ?? null,
    },
  });
  await auditStudio(db, workspaceId, null, "studio_creative_created", `Creative created: ${name} (${input.formatTrack}/${input.size}).`, actor);
  return serialize(row as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// PDF storage: workspace filesystem (/files/studio/creatives/<id>-v<n>.pdf).
// The store function is injectable so tests can stub it (no live DB needed).
// ---------------------------------------------------------------------------

export interface StoredPdf {
  fileId: string;
}

export async function defaultStoreCreativePdf(
  workspaceId: string,
  creativeId: string,
  version: number,
  bytes: Buffer,
  createdBy: string,
): Promise<StoredPdf> {
  const { writeFile } = await import("@/lib/filesystem/service");
  const logicalPath = `/files/studio/creatives/${creativeId}-v${version}.pdf`;
  const file = await writeFile({
    workspaceId,
    logicalPath,
    kind: "file",
    bytes,
    mimeType: "application/pdf",
    createdBy,
  });
  return { fileId: file.id };
}

export function creativePdfDownloadUrl(creativeId: string): string {
  return `/api/studio/creatives/${creativeId}/pdf`;
}

/**
 * Attach (or replace) the PDF on a creative: validates against its format
 * track, computes the stable hash, stores the bytes, and persists the report.
 * Ready creatives reject new PDFs — version instead.
 */
export async function setCreativePdf(
  db: Db,
  workspaceId: string,
  creativeId: string,
  pdfBytes: Buffer,
  opts?: {
    storePdf?: typeof defaultStoreCreativePdf;
    createdBy?: string;
    actor?: Actor;
  },
): Promise<Creative> {
  const row = await db.mailCreative.findFirst({ where: { id: creativeId, workspaceId } });
  if (!row) throw new CreativeHttpError(404, "Creative not found.");
  if (row.status === "ready") {
    throw new CreativeHttpError(409, "This creative is marked ready — create a new version instead of replacing its PDF.");
  }
  if (row.status === "archived") {
    throw new CreativeHttpError(409, "This creative version is archived.");
  }
  if (pdfBytes.length === 0) throw new CreativeHttpError(400, "PDF is empty.");
  if (pdfBytes.length > 25 * 1024 * 1024) {
    throw new CreativeHttpError(413, "PDF exceeds the 25 MB cap.");
  }
  const report = validateFormat(
    row.channelTemplate as ChannelTemplateId,
    row.formatTrack,
    row.size,
    pdfBytes,
    { source: row.source },
  );
  const store = opts?.storePdf ?? defaultStoreCreativePdf;
  const { fileId } = await store(workspaceId, row.id, row.version, pdfBytes, opts?.createdBy ?? row.createdBy ?? "system");
  report.fileId = fileId;
  const hash = computeCreativeHash(pdfBytes);
  const updated = await db.mailCreative.update({
    where: { id: row.id },
    data: {
      pdfUrl: creativePdfDownloadUrl(row.id),
      creativeHash: hash,
      validation: report as unknown as object,
    },
  });
  await auditStudio(
    db, workspaceId, null, "studio_creative_validated",
    `Creative "${row.name}" v${row.version} validated: ${report.ok ? "pass" : "FAIL"} (${report.issues.length} issue(s)).`,
    opts?.actor ?? "user",
  );
  return serialize(updated as unknown as Record<string, unknown>);
}

/**
 * New version = NEW ROW (version+1); the prior row is archived. The new row
 * starts as a draft with no PDF/hash — attach one via setCreativePdf.
 * Prior row is returned for convenience.
 */
export async function versionCreative(
  db: Db,
  workspaceId: string,
  creativeId: string,
  opts?: { name?: string; actor?: Actor; createdBy?: string },
): Promise<{ previous: Creative; next: Creative }> {
  const row = await db.mailCreative.findFirst({ where: { id: creativeId, workspaceId } });
  if (!row) throw new CreativeHttpError(404, "Creative not found.");
  if (row.status === "archived") {
    throw new CreativeHttpError(409, "Cannot version an archived creative — version its successor instead.");
  }
  const next = await db.mailCreative.create({
    data: {
      workspaceId,
      name: opts?.name?.trim() || row.name,
      channelTemplate: row.channelTemplate,
      formatTrack: row.formatTrack,
      size: row.size,
      source: row.source,
      version: row.version + 1,
      status: "draft",
      createdBy: opts?.createdBy ?? row.createdBy,
    },
  });
  const previous = await db.mailCreative.update({
    where: { id: row.id },
    data: { status: "archived" },
  });
  await auditStudio(
    db, workspaceId, null, "studio_creative_versioned",
    `Creative "${row.name}" versioned: v${row.version} archived -> v${row.version + 1} draft.`,
    opts?.actor ?? "user",
  );
  return {
    previous: serialize(previous as unknown as Record<string, unknown>),
    next: serialize(next as unknown as Record<string, unknown>),
  };
}

/** Mark a creative ready: requires a passing validation + the §7 attestation. */
export async function markReady(
  db: Db,
  workspaceId: string,
  creativeId: string,
  opts: { attested: boolean; attestedBy?: string; actor?: Actor },
): Promise<Creative> {
  const row = await db.mailCreative.findFirst({ where: { id: creativeId, workspaceId } });
  if (!row) throw new CreativeHttpError(404, "Creative not found.");
  if (row.status === "archived") throw new CreativeHttpError(409, "Archived creatives cannot be marked ready.");
  if (row.channelTemplate !== "print") {
    throw new CreativeHttpError(409, `Channel template "${row.channelTemplate}" is coming soon — mark-ready is gated until its format tracks are defined.`);
  }
  if (!opts.attested) {
    throw new CreativeHttpError(400, "Confirm the creative contains no USPS/government impersonation markings before marking it ready.");
  }
  const report = (row.validation ?? {}) as Partial<ValidationReport>;
  if (!row.pdfUrl || !row.creativeHash) {
    throw new CreativeHttpError(409, "Attach a PDF before marking this creative ready.");
  }
  if (report.ok !== true) {
    throw new CreativeHttpError(409, "Format validation did not pass — fix the reported issues before marking ready.");
  }
  const attestation: ValidationAttestation = {
    noGovernmentImpersonation: true,
    attestedBy: opts.attestedBy ?? null,
    attestedAt: new Date().toISOString(),
  };
  const updated = await db.mailCreative.update({
    where: { id: row.id },
    data: {
      status: "ready",
      validation: { ...report, attestation } as unknown as object,
    },
  });
  await auditStudio(
    db, workspaceId, null, "studio_creative_ready",
    `Creative "${row.name}" v${row.version} marked ready (hash ${String(row.creativeHash).slice(0, 12)}…, no-gov-impersonation attested).`,
    opts.actor ?? "user",
  );
  return serialize(updated as unknown as Record<string, unknown>);
}

export async function archiveCreative(
  db: Db,
  workspaceId: string,
  creativeId: string,
  actor: Actor = "user",
): Promise<Creative> {
  const row = await db.mailCreative.findFirst({ where: { id: creativeId, workspaceId } });
  if (!row) throw new CreativeHttpError(404, "Creative not found.");
  const updated = await db.mailCreative.update({ where: { id: row.id }, data: { status: "archived" } });
  await auditStudio(db, workspaceId, null, "studio_creative_archived", `Creative "${row.name}" v${row.version} archived.`, actor);
  return serialize(updated as unknown as Record<string, unknown>);
}



/** Start a max-quality PDF export for a creative's design. Returns the export job id. */

/**
 * Poll an export job once; when it succeeds, download the PDF and attach it
 * to the creative (validation + hash + storage). Idempotent: re-running after
 * success is a no-op returning the creative.
 */

/**
 * Full flow convenience: start the export, poll until done (bounded), then
 * attach. Used by the UI's "Export PDF" button.
 */
