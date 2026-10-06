// Marketr — white-label workspace logo upload (Phase 13 Wave A, worker 6).
// POST   /api/workspaces/white-label/logo  (multipart form, field "logo"; admin+)
// DELETE /api/workspaces/white-label/logo  (clears the logo; admin+)
//
// Reuses the brand-kit logo upload pattern: magic-byte validation (never the
// browser-declared MIME), malware screening, rejection auditing. Stored in
// the shared blob store (namespace "logos", <workspaceId>/wl-<workspaceId>.<ext>
// — deploy PR); served publicly by GET /api/public/workspaces/[id]/logo for
// the review landing page.

import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { deleteLogo, logoBlobPathFor, storeLogo } from "@/lib/brand-logo";
import { validateUploadBuffer } from "@/lib/security/upload-safety";
import { auditUploadRejected, screenUploadBuffer } from "@/lib/security/upload-audit";
import { EntitlementError, entitlementDenied, featureUpgradeMessage, planHasFeature } from "@/lib/billing/entitlements";

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
  // Phase 4a: white-label is a plan entitlement (403 + upgrade prompt).
  if (!planHasFeature(workspace.plan, "white_label")) {
    return entitlementDenied(new EntitlementError(featureUpgradeMessage("white_label"), "white_label"));
  }

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

  // Extension comes from the sniffed bytes, not the upload name.
  const logoPath = await storeLogo(workspace.id, storedFilename(workspace.id, check.ext), buf);
  if (workspace.whiteLabelLogoUrl && logoBlobPathFor(workspace.whiteLabelLogoUrl) !== logoBlobPathFor(logoPath)) {
    await deleteLogo(workspace.whiteLabelLogoUrl);
  }
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

  // DB row and storage can drift; clearing the field is what matters.
  if (workspace.whiteLabelLogoUrl) await deleteLogo(workspace.whiteLabelLogoUrl);
  await prisma.workspace.update({
    where: { id: workspace.id },
    data: { whiteLabelLogoUrl: null },
  });
  return Response.json({ ok: true });
}
