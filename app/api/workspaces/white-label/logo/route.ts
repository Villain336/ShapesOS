// Marketr — white-label workspace logo upload (Phase 13 Wave A, worker 6).
// POST   /api/workspaces/white-label/logo  (multipart form, field "logo"; admin+)
// DELETE /api/workspaces/white-label/logo  (clears the logo; admin+)
//
// Reuses the brand-kit logo upload pattern: magic-byte validation (never the
// browser-declared MIME), malware screening, rejection auditing. Stored under
// <REPORT_STORAGE_DIR>/logos/wl-<workspaceId>.<ext>; served publicly by
// GET /api/public/workspaces/[id]/logo for the review landing page.

import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { reportStorageDir } from "@/lib/pdf/generate";
import { resolveWithinDir, validateUploadBuffer } from "@/lib/security/upload-safety";
import { auditUploadRejected, screenUploadBuffer } from "@/lib/security/upload-audit";

export const dynamic = "force-dynamic";

const MAX_BYTES = 2 * 1024 * 1024;

function storedFilename(workspaceId: string, ext: string) {
  return `wl-${workspaceId}.${ext}`;
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "admin"))) return forbidden();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Expected multipart form data" }, { status: 400 });
  }
  const file = form.get("logo");
  if (!(file instanceof File)) {
    return Response.json({ error: "Missing 'logo' file field" }, { status: 400 });
  }
  const buf = Buffer.from(await file.arrayBuffer());
  const check = validateUploadBuffer(buf, {
    filename: file.name || "logo",
    maxBytes: MAX_BYTES,
    category: "images",
  });
  const reject = async (reason: string, status = 400) => {
    await auditUploadRejected({
      projectId: null,
      workspaceId: workspace.id,
      filename: file.name || "logo",
      reason,
      actorUserId: user.id,
    });
    return Response.json({ error: reason }, { status });
  };
  if (!check.ok) return reject(check.reason);
  // The white-label logo is served PUBLICLY on the app origin. SVG is active
  // content (script, external loads), so only raster formats are accepted.
  if (check.ext === "svg") {
    return reject("SVG logos aren't accepted for white-label branding. Upload a PNG, JPEG, GIF or WebP.");
  }
  const screen = await screenUploadBuffer(buf);
  if (!screen.ok) return reject(screen.reason, screen.status);

  const dir = path.join(reportStorageDir(), "logos");
  await fs.mkdir(dir, { recursive: true });
  // Extension comes from the sniffed bytes, not the upload name.
  const filename = storedFilename(workspace.id, check.ext);
  const abs = resolveWithinDir(dir, filename);
  await fs.writeFile(abs, buf);

  const logoPath = path.relative(process.cwd(), abs);
  await prisma.workspace.update({
    where: { id: workspace.id },
    data: { whiteLabelLogoUrl: logoPath },
  });
  return Response.json({ logoUrl: `/api/public/workspaces/${workspace.id}/logo` });
}

export async function DELETE() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "admin"))) return forbidden();

  const dir = path.join(reportStorageDir(), "logos");
  if (workspace.whiteLabelLogoUrl) {
    try {
      const abs = resolveWithinDir(dir, path.basename(workspace.whiteLabelLogoUrl));
      await fs.unlink(abs);
    } catch {
      // DB row and disk can drift; clearing the field is what matters.
    }
  }
  await prisma.workspace.update({
    where: { id: workspace.id },
    data: { whiteLabelLogoUrl: null },
  });
  return Response.json({ ok: true });
}
