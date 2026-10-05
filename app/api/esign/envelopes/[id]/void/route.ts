// Marketr — E-sign module API.
// POST /api/esign/envelopes/[id]/void — { reason }. Voids with a reason;
// the sealed artifact is never deleted.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { createDocumensoVendor } from "@/lib/esign/documenso-vendor";
import { EsignGateError, voidEnvelope } from "@/lib/esign/envelopes";
import { sidecarScoped } from "@/lib/integrations/sidecar-scope";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as { reason?: unknown } | null;
    const reason = typeof body?.reason === "string" ? body.reason : "";

    const vendor = createDocumensoVendor();
    const updated = await voidEnvelope(prisma, vendor, {
      envelopeId: id,
      reason,
      actor: `user:${user.id}`,
      workspaceId: workspace.id,
    });
    return Response.json({ envelope: { id: updated.id, status: updated.status } });
  } catch (e) {
    if (e instanceof EsignGateError) {
      const status = e.code === "unknown_envelope" ? 404 : e.code === "not_voidable" ? 409 : 422;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    return httpErrorResponse(e);
  }
}

// Phase 15.1: run in this workspace's sidecar scope — its own instance;
// a shared one is refused on hosted (lib/integrations/sidecar-tenancy.ts).
export const POST = sidecarScoped(handlePOST);
