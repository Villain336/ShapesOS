// Marketr — /api/mail/campaigns/[id]
// GET    → campaign detail (pieces summary + latest approval)
// PATCH  → update draft fields { name?, creativeId?, inHomeStart?, inHomeEnd? }
// DELETE → cancel a draft campaign

import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { mailGuard, badRequest } from "../../_lib";
import { NotFoundError, errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

async function getCampaign(workspaceId: string, id: string) {
  const campaign = await prisma.mailCampaign.findFirst({
    where: { id, workspaceId },
    include: {
      creative: true,
      provider: { select: { id: true, provider: true, mode: true, health: true } },
      approvals: { orderBy: { createdAt: "desc" }, take: 5 },
    },
  });
  if (!campaign) throw new NotFoundError("Mail campaign not found");
  return campaign;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mailGuard("viewer");
  if (gate instanceof Response) return gate;
  const { id } = await params;
  try {
    const campaign = await getCampaign(gate.workspaceId, id);
    const pieceStatus = await prisma.mailPiece.groupBy({
      by: ["status"],
      where: { campaignId: id },
      _count: true,
    });
    const verificationStatus = await prisma.mailPiece.groupBy({
      by: ["verificationStatus"],
      where: { campaignId: id },
      _count: true,
    });
    return Response.json({
      campaign,
      pieces: Object.fromEntries(pieceStatus.map((g) => [g.status, g._count])),
      verification: Object.fromEntries(verificationStatus.map((g) => [g.verificationStatus, g._count])),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  creativeId: z.string().trim().min(1).nullable().optional(),
  inHomeStart: z.string().datetime({ offset: true }).nullable().optional(),
  inHomeEnd: z.string().datetime({ offset: true }).nullable().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mailGuard("editor");
  if (gate instanceof Response) return gate;
  const { id } = await params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const parsed = PatchSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const campaign = await getCampaign(gate.workspaceId, id);
    if (!["draft", "pending_approval"].includes(campaign.status)) {
      return badRequest(`Cannot edit campaign in status ${campaign.status}`);
    }
    if (parsed.data.creativeId) {
      const c = await prisma.mailCreative.findFirst({
        where: { id: parsed.data.creativeId, workspaceId: gate.workspaceId },
      });
      if (!c) return badRequest("Creative not found in workspace");
    }
    const updated = await prisma.mailCampaign.update({
      where: { id },
      data: {
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.creativeId !== undefined ? { creativeId: parsed.data.creativeId } : {}),
        ...(parsed.data.inHomeStart !== undefined
          ? { inHomeStart: parsed.data.inHomeStart ? new Date(parsed.data.inHomeStart) : null }
          : {}),
        ...(parsed.data.inHomeEnd !== undefined
          ? { inHomeEnd: parsed.data.inHomeEnd ? new Date(parsed.data.inHomeEnd) : null }
          : {}),
      },
    });
    return Response.json({ campaign: updated });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mailGuard("editor");
  if (gate instanceof Response) return gate;
  const { id } = await params;
  try {
    const campaign = await getCampaign(gate.workspaceId, id);
    if (!["draft", "pending_approval", "cancelled"].includes(campaign.status)) {
      return badRequest(`Cannot cancel campaign in status ${campaign.status}`);
    }
    const updated = await prisma.mailCampaign.update({
      where: { id },
      data: { status: "cancelled" },
    });
    return Response.json({ campaign: updated });
  } catch (e) {
    return errorResponse(e);
  }
}
