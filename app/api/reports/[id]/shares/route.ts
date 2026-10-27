// ShapesOS — report share links (Phase 23).
// GET  /api/reports/[id]/shares — the report's links (any member; the report
//   is workspace-scoped through its template). Tokens are never listed.
// POST /api/reports/[id]/shares { label?, expiresInDays? } — mint a link
//   (editor+; ready/sent reports only). The raw token returns ONCE.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { createReportShare, listReportShares } from "@/lib/sharing/doc-shares";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  label: z.string().max(120).optional(),
  expiresInDays: z.number().int().min(1).max(90).optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await ctx.params;
    return Response.json({ shares: await listReportShares(workspace.id, id) });
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
      const { share, token } = await createReportShare({
        workspaceId: workspace.id,
        reportId: id,
        userId: user.id,
        label: parsed.data.label,
        expiresInDays: parsed.data.expiresInDays,
      });
      return Response.json({ share, token }, { status: 201 });
    } catch (err) {
      if (err instanceof Error && err.message === "REPORT_NOT_FOUND") {
        return Response.json({ error: "Report not found" }, { status: 404 });
      }
      if (err instanceof Error && err.message === "REPORT_NOT_READY") {
        return Response.json({ error: "Only a finished report can be shared" }, { status: 409 });
      }
      throw err;
    }
  } catch (e) {
    return httpErrorResponse(e);
  }
}
