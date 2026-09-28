// Marketr — Phase 13C: clip detail/patch.
// PATCH /api/clipper/clips/[id] {captionStyle?, captions?, action:"approve"?}
//   - captionStyle / captions: shallow-merge over the stored JSON.
//   - action "approve": status draft -> approved ONLY (409 otherwise).

import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { guardWorkspace, httpErrorResponse, readJson } from "../../../integrations/_lib";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.object({
  captionStyle: z.record(z.string(), z.unknown()).optional(),
  captions: z.record(z.string(), z.unknown()).optional(),
  action: z.enum(["approve"]).optional(),
}).refine((d) => d.captionStyle || d.captions || d.action, {
  message: "Nothing to update: provide captionStyle, captions, or action.",
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    const parsed = BodySchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }
    const clip = await withWorkspaceScope(workspace.id, (tx) =>
      tx.clip.findUnique({
        where: { id },
        select: { id: true, status: true, captionStyle: true, captions: true },
      }),
    );
    if (!clip) return Response.json({ error: "Clip not found." }, { status: 404 });

    const data: {
      captionStyle?: Prisma.InputJsonValue;
      captions?: Prisma.InputJsonValue;
      status?: string;
    } = {};
    if (parsed.data.captionStyle) {
      data.captionStyle = {
        ...((clip.captionStyle as Record<string, unknown>) ?? {}),
        ...parsed.data.captionStyle,
      } as Prisma.InputJsonValue;
    }
    if (parsed.data.captions) {
      data.captions = {
        ...((clip.captions as Record<string, unknown>) ?? {}),
        ...parsed.data.captions,
      } as Prisma.InputJsonValue;
    }
    if (parsed.data.action === "approve") {
      if (clip.status !== "draft") {
        return Response.json(
          { error: `Only draft clips can be approved (was ${clip.status}).` },
          { status: 409 },
        );
      }
      data.status = "approved";
    }

    const updated = await withWorkspaceScope(workspace.id, (tx) =>
      tx.clip.update({ where: { id }, data }),
    );
    return Response.json({ clip: updated });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
