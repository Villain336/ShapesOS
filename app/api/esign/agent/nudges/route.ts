// Marketr — E-sign module API.
// GET  /api/esign/agent/pending-nudges — signers waiting on live envelopes.
// POST /api/esign/agent/nudges/draft — draft a nudge for approval (nothing delivered).
// POST /api/esign/agent/nudges/approve — approve a drafted nudge (single-release).
// POST /api/esign/agent/nudges/record-delivery — record actual vendor-rail delivery.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { listPendingSigners, draftNudge, approveNudge, recordNudgeDelivery } from "@/lib/esign/agent";
import { EsignGateError } from "@/lib/esign/envelopes";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    const url = new URL(req.url);
    const idleDays = Number(url.searchParams.get("idleDays") ?? "3");
    const pending = await listPendingSigners(prisma, {
      workspaceId: workspace.id,
      idleDays: Number.isFinite(idleDays) ? idleDays : 3,
    });
    return Response.json({ pending });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

const DraftSchema = z.object({
  envelopeId: z.string().min(1),
  signerId: z.string().min(1),
  customMessage: z.string().max(2000).optional(),
});

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const url = new URL(req.url);
    const action = url.searchParams.get("action") ?? "draft";
    const body = await req.json().catch(() => null);

    if (action === "draft") {
      const parsed = DraftSchema.safeParse(body);
      if (!parsed.success) return Response.json({ error: "envelopeId and signerId are required." }, { status: 400 });
      const res = await draftNudge(prisma, {
        envelopeId: parsed.data.envelopeId,
        signerId: parsed.data.signerId,
        workspaceId: workspace.id,
        actor: `agent:${user.id}`,
        customMessage: parsed.data.customMessage,
      });
      return Response.json(res);
    }

    if (action === "approve") {
      const parsed = z.object({ nudgeEventId: z.string().min(1) }).safeParse(body);
      if (!parsed.success) return Response.json({ error: "nudgeEventId is required." }, { status: 400 });
      const res = await approveNudge(prisma, {
        nudgeEventId: parsed.data.nudgeEventId,
        workspaceId: workspace.id,
        actor: user.id,
      });
      return Response.json(res);
    }

    if (action === "record-delivery") {
      const parsed = z
        .object({
          nudgeId: z.string().min(1),
          envelopeId: z.string().min(1),
          deliveredVia: z.string().min(1).max(120),
        })
        .safeParse(body);
      if (!parsed.success) return Response.json({ error: "nudgeId, envelopeId and deliveredVia are required." }, { status: 400 });
      const res = await recordNudgeDelivery(prisma, {
        ...parsed.data,
        workspaceId: workspace.id,
        actor: `agent:${user.id}`,
      });
      return Response.json(res);
    }

    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (e) {
    if (e instanceof EsignGateError) {
      const status = e.code === "unknown_envelope" || e.code === "unknown_nudge" ? 404 : 422;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    return httpErrorResponse(e);
  }
}
