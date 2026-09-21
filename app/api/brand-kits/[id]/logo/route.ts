// Marketr — brand kit logo upload (milestone 12).
// POST /api/brand-kits/[id]/logo  (multipart form, field "logo"; editor+)
// Stores under <REPORT_STORAGE_DIR>/logos/<kitId>.<ext>, updates logoPath.

import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { reportStorageDir } from "@/lib/pdf/generate";

const ALLOWED = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/svg+xml", ".svg"],
]);
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
  const ext = ALLOWED.get(file.type);
  if (!ext) {
    return Response.json({ error: "Logo must be PNG, JPEG, or SVG" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: "Logo must be under 2 MB" }, { status: 400 });
  }

  const dir = path.join(reportStorageDir(), "logos");
  await fs.mkdir(dir, { recursive: true });
  const filename = `${id}${ext}`;
  const abs = path.join(dir, filename);
  await fs.writeFile(abs, Buffer.from(await file.arrayBuffer()));

  const updated = await prisma.brandKit.update({
    where: { id },
    data: { logoPath: path.relative(process.cwd(), abs) },
  });
  return Response.json({ brandKit: updated });
}
