// Marketr — brand-kit logo file serving (Phase 13 Wave A, white-label ops).
// Logos live in the shared blob store, namespace "logos" (deploy PR): new
// uploads are stored as <workspaceId>/<kitId>.<ext> and the row holds the
// blob ref; rows from before hold ".data/reports/logos/<file>" and resolve
// by file name inside the namespace (with MARKETR_STORAGE=local that is
// <REPORT_STORAGE_DIR>/logos, where those files always lived).
// This helper resolves a workspace's DEFAULT brand kit logo to bytes + MIME,
// used by the authed dashboard GET (/api/brand-kits/[id]/logo) and the
// public white-label URL (/api/public/workspaces/[id]/logo) the review
// landing page renders.

import path from "node:path";
import { prisma } from "./prisma";
import { assertBlobSegment, blobGet, blobPath, blobPut, deleteStoredRef, encodeBlobSegment, parseBlobRef } from "./filesystem/storage";
import { USER_CONTENT_CSP } from "./security/headers";
import { effectiveWhiteLabel } from "./billing/entitlements";

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

export type BrandLogoFile = {
  bytes: Buffer;
  mime: string;
  filename: string;
};

/**
 * Load the workspace's default brand kit logo from disk.
 * Returns null when there is no default kit, no logo, or the file is gone
 * (DB row and disk can drift — a missing file is an honest 404, not a 500).
 */
export async function loadDefaultBrandLogo(workspaceId: string): Promise<BrandLogoFile | null> {
  const kit = await prisma.brandKit.findFirst({
    where: { workspaceId, isDefault: true },
    select: { id: true, logoPath: true },
  });
  return loadBrandKitLogoFile(kit?.logoPath ?? null);
}

/**
 * Load the workspace's WHITE-LABEL logo (Workspace.whiteLabelLogoUrl) from
 * disk — the logo the public review landing page renders. Returns null when
 * unset, when the workspace is unknown, or when the file is gone (DB row and
 * disk can drift — a missing file is an honest 404, not a 500).
 */
export async function loadWhiteLabelLogo(workspaceId: string): Promise<BrandLogoFile | null> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { plan: true, whiteLabelLogoUrl: true, whiteLabelCustomDomain: true, whiteLabelBrandColor: true },
  });
  if (!ws) return null;
  // Phase 4a: a plan without white-label publishes no logo (honest 404).
  return loadBrandKitLogoFile(effectiveWhiteLabel(ws).logoUrl);
}

/**
 * Response headers for serving an uploaded logo. Uploaded bytes are user
 * content: nosniff + a sandboxed, resource-less CSP on every response, and
 * SVG is served as an attachment so navigating to the URL never renders it
 * on the app origin (an <img src> still displays it — images ignore
 * Content-Disposition, and SVG-as-image never runs script).
 */
export function brandLogoHeaders(file: BrandLogoFile, cacheControl: string): Record<string, string> {
  const safeName = file.filename.replace(/["\\\r\n]/g, "_").slice(0, 200) || "logo";
  const isSvg = file.mime === "image/svg+xml";
  return {
    "Content-Type": file.mime,
    "Cache-Control": cacheControl,
    "Content-Disposition": `${isSvg ? "attachment" : "inline"}; filename="${safeName}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": USER_CONTENT_CSP,
  };
}

/** Where a stored logo ref lives in the "logos" namespace (null = not servable). */
export function logoBlobPathFor(logoPath: string | null | undefined): string | null {
  const stored = logoPath?.trim();
  if (!stored) return null;
  const ref = parseBlobRef(stored);
  if (stored.startsWith("blob:")) return ref && ref.namespace === "logos" ? ref.path : null;
  // Legacy rows: only the file name counts — never trust the stored directory.
  try {
    return assertBlobSegment(path.basename(stored));
  } catch {
    return null;
  }
}

/** Resolve one brand kit's (or white-label) logo ref to bytes. */
export async function loadBrandKitLogoFile(logoPath: string | null): Promise<BrandLogoFile | null> {
  const key = logoBlobPathFor(logoPath);
  if (!key) return null;
  const filename = key.split("/").pop()!;
  // Only serve known image extensions (magic-byte-validated at upload).
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const mime = EXT_MIME[ext];
  if (!mime) return null;
  const bytes = await blobGet("logos", key).catch(() => null);
  return bytes ? { bytes, mime, filename } : null;
}

/** Store an uploaded (already validated + screened) logo; returns the ref to keep on the row. */
export async function storeLogo(workspaceId: string, filename: string, bytes: Buffer): Promise<string> {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return blobPut("logos", blobPath(encodeBlobSegment(workspaceId), assertBlobSegment(filename)), bytes, EXT_MIME[ext] ?? "application/octet-stream");
}

/** Remove a stored logo (blob ref or legacy file name). Missing is fine. */
export async function deleteLogo(logoPath: string | null | undefined): Promise<void> {
  const key = logoBlobPathFor(logoPath);
  if (!key) return;
  await deleteStoredRef(`blob:logos/${key}`, "logos").catch(() => undefined);
}
