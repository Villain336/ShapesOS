// Marketr — E-sign module API.
// GET /api/esign/envelopes/[id] — envelope detail with signers, fields, audit trail.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await ctx.params;
    const envelope = await prisma.esignEnvelope.findFirst({
      where: { id, workspaceId: workspace.id },
      include: {
        signers: { orderBy: { orderIndex: "asc" } },
        fields: true,
        events: { orderBy: { createdAt: "asc" }, take: 200 },
        vaultEntry: true,
      },
    });
    if (!envelope) return Response.json({ error: "Envelope not found." }, { status: 404 });
    return Response.json({
      envelope: {
        id: envelope.id,
        title: envelope.title,
        status: envelope.status,
        signingOrder: envelope.signingOrder,
        vendor: envelope.vendor,
        vendorRef: envelope.vendorRef,
        vendorStatus: envelope.vendorStatus,
        documentName: envelope.documentName,
        expiresAt: envelope.expiresAt?.toISOString() ?? null,
        sourcePdfHash: envelope.sourcePdfHash,
        sealedPdfHash: envelope.sealedPdfHash,
        sealedPdfFetchedAt: envelope.sealedPdfFetchedAt?.toISOString() ?? null,
        voidReason: envelope.voidReason,
        contractType: envelope.contractType,
        contractRef: envelope.contractRef,
        vaultEntry: envelope.vaultEntry
          ? {
              id: envelope.vaultEntry.id,
              storedAt: envelope.vaultEntry.storedAt.toISOString(),
              retentionUntil: envelope.vaultEntry.retentionUntil?.toISOString() ?? null,
              legalHold: envelope.vaultEntry.legalHold,
              legalHoldReason: envelope.vaultEntry.legalHoldReason,
              purgedAt: envelope.vaultEntry.purgedAt?.toISOString() ?? null,
            }
          : null,
        createdAt: envelope.createdAt.toISOString(),
        signers: envelope.signers.map((s) => ({
          id: s.id,
          name: s.name,
          email: s.email,
          role: s.role,
          orderIndex: s.orderIndex,
          status: s.status,
          signedAt: s.signedAt?.toISOString() ?? null,
        })),
        fields: envelope.fields.map((f) => ({
          id: f.id,
          signerId: f.signerId,
          fieldType: f.fieldType,
          page: f.page,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
          required: f.required,
        })),
        events: envelope.events.map((e) => ({
          id: e.id,
          event: e.event,
          actor: e.actor,
          hash: e.hash,
          previousHash: e.previousHash,
          createdAt: e.createdAt.toISOString(),
        })),
      },
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
