// ShapesOS — GET /api/workspaces/[id]/export (Phase 4a, GDPR portability).
// Owners and admins download everything the workspace owns as one streamed
// JSON document (lib/gdpr/workspace-export.ts): RLS-scoped, secrets left
// out, one export per workspace at a time, and the download is recorded in
// the workspace's audit log.

import { requireUser } from "@/lib/session";
import { errorResponse } from "@/lib/api/errors";
import { forbidden, requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { log, requestIdFrom } from "@/lib/observability/log";
import { exportFilename, workspaceExport } from "@/lib/gdpr/workspace-export";
import { textStream } from "@/lib/gdpr/stream";
import { claimExportSlot, releaseExportSlot, releasingStream } from "@/lib/gdpr/limit";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await params;
    if (!(await requireWorkspaceRole(user.id, id, "admin"))) return forbidden();
    const ws = await prisma.workspace.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!ws) return Response.json({ error: "Workspace not found." }, { status: 404 });

    const slot = `workspace:${ws.id}`;
    if (!claimExportSlot(slot)) {
      return Response.json({ error: "An export of this workspace is already running. Try again when it finishes." }, { status: 429 });
    }
    try {
      await prisma.fileChangeLog.create({
        data: {
          workspaceId: ws.id,
          filePath: "(workspace)",
          actor: "user",
          action: "workspace_exported",
          summary: "Full workspace data export downloaded",
          approvedBy: user.id,
        },
      });
    } catch (err) {
      releaseExportSlot(slot);
      throw err;
    }
    const now = new Date();
    const requestId = requestIdFrom(req);
    const gen = workspaceExport(ws.id, now);
    const logged = (async function* () {
      try {
        yield* gen;
      } catch (err) {
        // Headers are already sent: the download ends early; leave a trace.
        log.error("workspace export failed mid-stream", { requestId, workspaceId: ws.id, err });
        throw err;
      }
    })();
    return new Response(releasingStream(textStream(logged), slot), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename("workspace", ws.name, now)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err, "GET /api/workspaces/[id]/export", req);
  }
}
