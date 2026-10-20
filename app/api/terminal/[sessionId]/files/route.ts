// ShapesOS — Phase 21B (WS=drive): the Terminal's upload / download bridge to Drive.
// POST /api/terminal/[sessionId]/files  (editor+, and only the person's OWN session)
//   { workspaceId, direction: "upload",   drivePath, sandboxDir? }          Drive file -> the terminal's directory
//   { workspaceId, direction: "download", sandboxPath, driveDir, overwrite? } a terminal file -> a Drive folder
// It is the PERSON's action with the PERSON's rights: they can only upload what they can read and only
// download into a folder they can write; symbolic links are refused; the normal upload gate, the
// malware scan, the quota, versions and the change journal apply. 25 MB per file.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { badRequest, requireWorkspaceAccess } from "@/lib/route-utils";
import { filesErrorResponse } from "@/lib/files/http";
import { terminalSandbox } from "@/lib/terminal/service";
import { downloadFromSandbox, uploadToSandbox } from "@/lib/drive/sandbox-bridge";
import { normalizeFolderPath } from "@/lib/filesystem/paths";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ sessionId: string }> };

const Body = z.discriminatedUnion("direction", [
  z.object({ workspaceId: z.string().min(1).max(120), direction: z.literal("upload"), drivePath: z.string().min(1).max(1100), sandboxDir: z.string().max(1024).optional() }),
  z.object({ workspaceId: z.string().min(1).max(120), direction: z.literal("download"), sandboxPath: z.string().min(1).max(1024), driveDir: z.string().min(1).max(1100), overwrite: z.boolean().optional() }),
]);

export async function POST(req: NextRequest, ctx: Ctx) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { sessionId } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid request.");
  const b = parsed.data;
  const access = await requireWorkspaceAccess(user.id, b.workspaceId, "editor");
  if ("error" in access) return access.error;
  const actor = { workspaceId: access.workspaceId, userId: user.id, role: access.membership.role };
  try {
    const sandbox = await terminalSandbox(actor, sessionId);
    if (b.direction === "upload") {
      return Response.json(await uploadToSandbox({ sandbox, actor, drivePath: b.drivePath, sandboxDir: b.sandboxDir }));
    }
    const dir = normalizeFolderPath(b.driveDir);
    if (!dir.ok) return badRequest(dir.reason);
    return Response.json(await downloadFromSandbox({ sandbox, actor, sandboxPath: b.sandboxPath, driveDir: dir.path, overwrite: b.overwrite }), { status: 201 });
  } catch (err) {
    return filesErrorResponse(err, "terminal files");
  }
}
