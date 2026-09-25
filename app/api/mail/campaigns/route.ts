// Marketr — /api/mail/campaigns
// GET  → list campaigns (workspace-scoped)
// POST → create a campaign { name, providerId?, creativeId?, inHomeStart?, inHomeEnd? }
//        Pieces are built afterwards via POST /[id]/audience.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { mailGuard, badRequest } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await mailGuard("viewer");
  if (gate instanceof Response) return gate;

  const q = new URL(req.url).searchParams;
  const limit = Math.min(Math.max(Number(q.get("limit") ?? 50) || 50, 1), 200);
  const status = q.get("status")?.trim();

  const campaigns = await prisma.mailCampaign.findMany({
    where: { workspaceId: gate.workspaceId, ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      creative: { select: { id: true, name: true, formatTrack: true, size: true, status: true } },
      provider: { select: { id: true, provider: true, mode: true } },
    },
  });
  return Response.json({ campaigns, workspaceId: gate.workspaceId });
}

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  providerId: z.string().trim().min(1).optional(),
  creativeId: z.string().trim().min(1).optional(),
  inHomeStart: z.string().datetime({ offset: true }).optional(),
  inHomeEnd: z.string().datetime({ offset: true }).optional(),
});

export async function POST(req: Request) {
  const gate = await mailGuard("editor");
  if (gate instanceof Response) return gate;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const parsed = CreateSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);
  const { name, providerId, creativeId, inHomeStart, inHomeEnd } = parsed.data;

  // Workspace-scope every relation the campaign references.
  if (providerId) {
    const p = await prisma.mailProvider.findFirst({ where: { id: providerId, workspaceId: gate.workspaceId } });
    if (!p) return badRequest("Mail provider not found in workspace");
  }
  if (creativeId) {
    const c = await prisma.mailCreative.findFirst({ where: { id: creativeId, workspaceId: gate.workspaceId } });
    if (!c) return badRequest("Creative not found in workspace");
  }

  const campaign = await prisma.mailCampaign.create({
    data: {
      workspaceId: gate.workspaceId,
      name,
      providerId: providerId ?? null,
      creativeId: creativeId ?? null,
      audienceSource: { kind: "unset" },
      inHomeStart: inHomeStart ? new Date(inHomeStart) : null,
      inHomeEnd: inHomeEnd ? new Date(inHomeEnd) : null,
      createdBy: gate.userId,
    },
  });
  return Response.json({ campaign }, { status: 201 });
}
