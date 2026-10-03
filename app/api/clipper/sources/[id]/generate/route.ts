// Marketr — Phase 13C: enqueue clip generation for a source.
// POST /api/clipper/sources/[id]/generate {count?: number}
// Requires transcriptStatus === "ready"; creates ClipJob{kind:"generate", payload:{count}}.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "../../../../integrations/_lib";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { createClipJob } from "../../../_pipeline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.object({
  count: z.number().int().min(1).max(10).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    const parsed = BodySchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }
    const source = await withWorkspaceScope(workspace.id, (tx) =>
      tx.clipSource.findUnique({
        where: { id, workspaceId: workspace.id },
        select: { id: true, transcriptStatus: true },
      }),
    );
    if (!source) return Response.json({ error: "Source not found." }, { status: 404 });
    if (source.transcriptStatus !== "ready") {
      return Response.json(
        { error: `Transcript is not ready (status: ${source.transcriptStatus}).` },
        { status: 409 },
      );
    }
    const job = await createClipJob(workspace.id, {
      kind: "generate",
      sourceId: source.id,
      payload: { count: parsed.data.count ?? 3 },
    });
    return Response.json({ job }, { status: 201 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
