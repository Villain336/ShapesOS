// Marketr — Phase 13C: enqueue a render.
// POST /api/clipper/clips/[id]/render — only when status is draft or approved.
// Creates ClipJob{kind:"render", payload:{clipId}}; the processor does the
// ffmpeg work and flips renderStatus itself.

import { guardWorkspace, httpErrorResponse } from "../../../../integrations/_lib";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { createClipJob } from "../../../_pipeline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    const clip = await withWorkspaceScope(workspace.id, (tx) =>
      tx.clip.findUnique({
        where: { id, workspaceId: workspace.id },
        select: { id: true, status: true, renderStatus: true },
      }),
    );
    if (!clip) return Response.json({ error: "Clip not found." }, { status: 404 });
    if (clip.status !== "approved" && clip.status !== "draft") {
      return Response.json(
        { error: `Only draft or approved clips can be rendered (was ${clip.status}).` },
        { status: 409 },
      );
    }
    if (clip.renderStatus === "processing") {
      return Response.json({ error: "A render is already in progress for this clip." }, { status: 409 });
    }
    const job = await createClipJob(workspace.id, {
      kind: "render",
      payload: { clipId: clip.id },
    });
    return Response.json({ job }, { status: 201 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
