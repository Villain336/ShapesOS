// Marketr — brand kit logo upload (milestone 12).
// POST /api/brand-kits/[id]/logo  (multipart form, field "logo"; editor+)
// Stores in the shared blob store (namespace "logos",
// <workspaceId>/<kitId>.<ext> — deploy PR) and sets logoPath to the blob ref.

import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { deleteLogo, logoBlobPathFor, storeLogo } from "@/lib/brand-logo";
import { validateUploadBuffer } from "@/lib/security/upload-safety";
import { auditUploadRejected, screenUploadBuffer } from "@/lib/security/upload-audit";

const MAX_BYTES = 2 * 1024 * 1024;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const brandKit = await prisma.brandKit.findFirst({ where: { id, workspaceId: workspace.id } });
  if (!brandKit) return Response.json({ error: "Brand kit not found" }, { status: 404 });
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

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
  // Phase A (fix 5): verify magic bytes — the browser-declared MIME type is
  // never trusted — then malware-screen before touching disk.
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
  const screen = await screenUploadBuffer(buf);
  if (!screen.ok) return reject(screen.reason, screen.status);

  // The stored extension comes from the sniffed bytes, not the upload name.
  const logoPath = await storeLogo(workspace.id, `${id}.${check.ext}`, buf);
  // A previous logo with another extension (or a legacy file) is replaced.
  if (brandKit.logoPath && logoBlobPathFor(brandKit.logoPath) !== logoBlobPathFor(logoPath)) {
    await deleteLogo(brandKit.logoPath);
  }

  const updated = await prisma.brandKit.update({
    where: { id },
    data: { logoPath },
  });
  return Response.json({ brandKit: updated });
}
