// Marketr — POST /api/documenso/requests/[id]/refresh
// Re-reads the signing request's status from Documenso and stores it.
// Editor+ only, workspace-scoped.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import {
  DocumensoApiError,
  documensoStatus,
  getDocumensoDocument,
} from "@/lib/integrations/documenso";
import { sidecarScoped } from "@/lib/integrations/sidecar-scope";

export const dynamic = "force-dynamic";

async function handlePOST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { workspace } = await guardWorkspace({ editor: true });
    const row = await prisma.signingRequest.findFirst({
      where: { id, workspaceId: workspace.id },
    });
    if (!row) return Response.json({ error: "Signing request not found" }, { status: 404 });
    if (!row.documensoDocumentId) {
      return Response.json(
        { error: "This request never reached Documenso — nothing to refresh." },
        { status: 400 },
      );
    }
    if (!documensoStatus().configured) {
      return Response.json(
        { error: "Documenso is not configured." },
        { status: 503 },
      );
    }
    try {
      const doc = await getDocumensoDocument(row.documensoDocumentId);
      const updated = await prisma.signingRequest.update({
        where: { id: row.id },
        data: { status: doc.status },
      });
      return Response.json({
        request: {
          id: updated.id,
          status: updated.status,
          documensoDocumentId: updated.documensoDocumentId,
        },
      });
    } catch (e) {
      const message =
        e instanceof DocumensoApiError ? e.message : "Documenso request failed.";
      return Response.json({ error: message }, { status: 502 });
    }
  } catch (e) {
    return httpErrorResponse(e);
  }
}

// Phase 15.1: run in this workspace's sidecar scope — its own instance;
// a shared one is refused on hosted (lib/integrations/sidecar-tenancy.ts).
export const POST = sidecarScoped(handlePOST);
