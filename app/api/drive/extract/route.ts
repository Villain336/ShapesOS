// ShapesOS — Phase 21B (WS=drive): upload a .zip and unpack it into a folder.
// POST /api/drive/extract  multipart: workspaceId, dir, file (the zip)   (editor+)
// The archive is scanned as a whole, its entries are checked (names, symbolic links, zip-bomb limits —
// lib/drive/extract.ts) and each file goes through the normal upload gate; nothing is overwritten.
// Returns {created, skippedByArchive, rejected}: every refusal is listed with its reason.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { badRequest, requireWorkspaceAccess } from "@/lib/route-utils";
import { filesErrorResponse } from "@/lib/files/http";
import { normalizeFolderPath } from "@/lib/filesystem/paths";
import { extractZipInto } from "@/lib/drive/ops";

export const dynamic = "force-dynamic";
const MAX_ZIP_BYTES = 100 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!(req.headers.get("content-type") ?? "").includes("multipart")) return badRequest("Expected multipart form data.");
  const form = await req.formData();
  const access = await requireWorkspaceAccess(user.id, String(form.get("workspaceId") ?? ""), "editor");
  if ("error" in access) return access.error;
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return badRequest("Missing file field.");
  if (file.size > MAX_ZIP_BYTES) return Response.json({ error: "A zip to unpack can be up to 100 MB." }, { status: 413 });
  const dir = normalizeFolderPath(String(form.get("dir") ?? ""));
  if (!dir.ok) return badRequest(dir.reason);
  try {
    const report = await extractZipInto({ workspaceId: access.workspaceId, userId: user.id, role: access.membership.role }, { dir: dir.path, zip: Buffer.from(await file.arrayBuffer()) });
    return Response.json(report, { status: 201 });
  } catch (err) {
    return filesErrorResponse(err, "drive extract");
  }
}
