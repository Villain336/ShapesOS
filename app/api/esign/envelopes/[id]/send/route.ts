// Marketr — E-sign module API.
// GET  /api/esign/envelopes/[id]/send-preview — the heavy gate's review step.
//   Returns the full send summary plus the confirmation token the human must
//   echo back on POST /send. The token binds to the exact draft bytes.
// POST /api/esign/envelopes/[id]/send — { token }. Sends ONLY on a fresh,
//   matching token for a draft that has not changed since preview.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { documensoStatus } from "@/lib/integrations/documenso";
import { createDocumensoVendor } from "@/lib/esign/documenso-vendor";
import { buildSendToken, EsignGateError, sendEnvelope } from "@/lib/esign/envelopes";
import { sidecarScoped } from "@/lib/integrations/sidecar-scope";

export const dynamic = "force-dynamic";

async function load(workspaceId: string, id: string) {
  return prisma.esignEnvelope.findFirst({
    where: { id, workspaceId },
    include: { signers: { orderBy: { orderIndex: "asc" } }, fields: true },
  });
}

async function handleGET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    const envelope = await load(workspace.id, id);
    if (!envelope) return Response.json({ error: "Envelope not found." }, { status: 404 });
    // "error" = an earlier send failed; it can be reviewed and re-sent.
    if (envelope.status !== "draft" && envelope.status !== "error") {
      return Response.json({ error: `Only drafts can be sent (status: ${envelope.status}).` }, { status: 409 });
    }
    const token = buildSendToken({
      id: envelope.id,
      title: envelope.title,
      signerEmails: envelope.signers.map((s) => s.email),
      signingOrder: envelope.signingOrder,
      expiresAt: envelope.expiresAt,
      sourcePdfHash: envelope.sourcePdfHash,
    });
    return Response.json({
      preview: {
        title: envelope.title,
        documentName: envelope.documentName,
        documentSize: envelope.documentSize,
        sourcePdfHash: envelope.sourcePdfHash,
        signingOrder: envelope.signingOrder,
        expiresAt: envelope.expiresAt?.toISOString() ?? null,
        signers: envelope.signers.map((s) => ({
          name: s.name,
          email: s.email,
          role: s.role,
          orderIndex: s.orderIndex,
        })),
        fieldCount: envelope.fields.length,
        vendorConfigured: documensoStatus().configured,
      },
      token,
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

async function handlePOST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
    const token = typeof body?.token === "string" ? body.token : "";

    const vendor = createDocumensoVendor();
    const updated = await sendEnvelope(prisma, vendor, {
      envelopeId: id,
      token,
      actor: `user:${user.id}`,
      workspaceId: workspace.id,
    });

    return Response.json({ envelope: { id: updated.id, status: updated.status, vendorRef: updated.vendorRef } });
  } catch (e) {
    if (e instanceof EsignGateError) {
      const status = e.code === "stale_token" || e.code === "not_draft" ? 409 : 422;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    return httpErrorResponse(e);
  }
}

// Phase 15.1: run in this workspace's sidecar scope — its own instance;
// a shared one is refused on hosted (lib/integrations/sidecar-tenancy.ts).
export const GET = sidecarScoped(handleGET);
export const POST = sidecarScoped(handlePOST);
