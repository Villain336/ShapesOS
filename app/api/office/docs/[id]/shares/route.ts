// ShapesOS — Office doc share links (Phase 23; the Studio share pattern on
// the Office surface).
// GET  /api/office/docs/[id]/shares — the doc's links (viewer+). Tokens are
//   capability secrets: the list NEVER returns them.
// POST /api/office/docs/[id]/shares { label?, expiresInDays? } — mint a link
//   (editor+). The raw token is returned ONCE here; only its SHA-256 is kept.
//   Creating a link is a consequential action: the UI puts an explicit
//   confirmation step in front of it (what the link exposes, who can open it,
//   when it expires). Nothing is shared merely by opening the doc.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { createDocShare, listDocShares } from "@/lib/sharing/doc-shares";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  label: z.string().max(120).optional(),
  expiresInDays: z.number().int().min(1).max(90).optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await ctx.params;
    return Response.json({ shares: await listDocShares(workspace.id, id) });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    let raw: unknown = {};
    try {
      raw = await readJson(req);
    } catch {
      raw = {};
    }
    const parsed = CreateSchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }
    try {
      const { share, token } = await createDocShare({
        workspaceId: workspace.id,
        docId: id,
        userId: user.id,
        label: parsed.data.label,
        expiresInDays: parsed.data.expiresInDays,
      });
      return Response.json({ share, token }, { status: 201 });
    } catch (err) {
      if (err instanceof Error && err.message === "DOC_NOT_FOUND") {
        return Response.json({ error: "Doc not found" }, { status: 404 });
      }
      if (err instanceof Error && err.message.startsWith("UNSUPPORTED_CONTENT:")) {
        return Response.json(
          { error: "This document has content the read-only viewer can't show yet", reason: err.message.slice(20) },
          { status: 422 },
        );
      }
      throw err;
    }
  } catch (e) {
    return httpErrorResponse(e);
  }
}
