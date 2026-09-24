// Marketr — CRM lead activities (the timeline).
// GET  /api/crm/leads/[id]/activities
// POST /api/crm/leads/[id]/activities  → { type, body?, actor? } (editor+)

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { recomputeScore, logActivity } from "@/lib/crm/dedup";

const TYPES = ["note", "email", "call", "sms", "meeting"] as const;

const CreateSchema = z.object({
  type: z.enum(TYPES),
  body: z.string().trim().min(1).max(4000),
  actor: z.string().trim().max(160).optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const { id } = await ctx.params;
  const lead = await prisma.lead.findFirst({ where: { id, workspaceId: workspace.id } });
  if (!lead) return Response.json({ error: "Not found" }, { status: 404 });
  const activities = await prisma.leadActivity.findMany({
    where: { leadId: id },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return Response.json({ activities });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();
  const { id } = await ctx.params;
  const lead = await prisma.lead.findFirst({ where: { id, workspaceId: workspace.id } });
  if (!lead) return Response.json({ error: "Not found" }, { status: 404 });

  let body: unknown;
  try { body = await req.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const activity = await logActivity({
    workspaceId: workspace.id,
    leadId: lead.id,
    type: parsed.data.type,
    body: parsed.data.body,
    actor: parsed.data.actor ?? user.name ?? user.email ?? "User",
  });
  await recomputeScore(lead.id, workspace.id);
  return Response.json({ activity }, { status: 201 });
}
