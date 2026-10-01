// Marketr — E-sign module API.
// POST /api/esign/envelopes/[id]/vault — store a completed envelope's sealed
// artifact in the legal vault (optional retentionDays).

import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { storeInVault } from "@/lib/esign/vault";
import { EsignGateError } from "@/lib/esign/envelopes";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  retentionDays: z.number().int().min(1).max(36500).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: "Invalid retention." }, { status: 400 });
    const entry = await storeInVault(prisma, {
      envelopeId: id,
      workspaceId: workspace.id,
      retentionDays: parsed.data.retentionDays,
      actor: user.id,
    });
    return Response.json({
      vaultEntry: {
        id: entry.id,
        sealedPdfHash: entry.sealedPdfHash,
        auditHeadHash: entry.auditHeadHash,
        eventCount: entry.eventCount,
        signerCount: entry.signerCount,
        storedAt: entry.storedAt.toISOString(),
        retentionUntil: entry.retentionUntil?.toISOString() ?? null,
        legalHold: entry.legalHold,
      },
    });
  } catch (e) {
    if (e instanceof EsignGateError) {
      const status = e.code === "unknown_envelope" ? 404 : 422;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    return httpErrorResponse(e);
  }
}
