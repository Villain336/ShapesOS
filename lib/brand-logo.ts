// Marketr — brand-kit logo file serving (Phase 13 Wave A, white-label ops).
// Logos live on disk at <REPORT_STORAGE_DIR>/logos/<kitId>.<ext> (see
// POST /api/brand-kits/[id]/logo); nothing in the app served them until now.
// This helper resolves a workspace's DEFAULT brand kit logo to bytes + MIME,
// used by the authed dashboard GET (/api/brand-kits/[id]/logo) and the
// public white-label URL (/api/public/workspaces/[id]/logo) the review
// landing page renders.

import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "./prisma";
import { reportStorageDir } from "./pdf/generate";
import { resolveWithinDir } from "./security/upload-safety";

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
    select: { whiteLabelLogoUrl: true },
  });
  if (!ws) return null;
  return loadBrandKitLogoFile(ws.whiteLabelLogoUrl);
}

/** Resolve one brand kit's logoPath (repo-root-relative) to bytes. */
export async function loadBrandKitLogoFile(logoPath: string | null): Promise<BrandLogoFile | null> {
  if (!logoPath?.trim()) return null;
  const dir = path.join(reportStorageDir(), "logos");
  const filename = path.basename(logoPath.trim());
  // Never trust the stored name: confine reads to the logos dir and only
  // serve known image extensions (magic-byte-validated at upload).
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const mime = EXT_MIME[ext];
  if (!mime) return null;
  let abs: string;
  try {
    abs = resolveWithinDir(dir, filename);
  } catch {
    return null;
  }
  try {
    const bytes = await fs.readFile(abs);
    return { bytes: Buffer.from(bytes), mime, filename };
  } catch {
    return null;
  }
}
