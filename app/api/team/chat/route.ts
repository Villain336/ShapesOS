// Marketr — per-project team chat API (redesign §3b).
// GET  /api/team/chat?projectId=…[&after=iso] → { channel, messages }
// POST /api/team/chat  { projectId, body }   → { message } (201)
// Any project member (viewer+) may read and post. The ChatChannel is
// auto-created on first post. Author name is snapshotted at send time.

import { accessibleWorkspaceWhere, getMembership, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const MAX_BODY = 2000;

async function projectAccess(userId: string, projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspace: accessibleWorkspaceWhere(userId) },
    select: { id: true, workspaceId: true, domain: true },
  });
  if (!project) return null;
  if (!(await requireProjectRole(userId, project.id, "viewer"))) return null;
  return project;
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) return Response.json({ error: "projectId is required" }, { status: 400 });
  const project = await projectAccess(user.id, projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  const channel = await prisma.chatChannel.findUnique({
    where: { projectId: project.id },
    select: { id: true, name: true },
  });
  if (!channel) return Response.json({ channel: null, messages: [] });

  const afterParam = req.nextUrl.searchParams.get("after");
  let after: Date | null = null;
  if (afterParam) {
    const d = new Date(afterParam);
    if (!Number.isNaN(d.getTime())) after = d;
  }

  const messages = await prisma.teamChatMessage.findMany({
    where: { channelId: channel.id, ...(after ? { createdAt: { gt: after } } : {}) },
    orderBy: { createdAt: "asc" },
    take: 200,
    select: { id: true, userId: true, authorName: true, body: true, createdAt: true },
  });
  return Response.json({
    channel,
    messages: messages.map((m) => ({
      id: m.id,
      userId: m.userId,
      authorName: m.authorName,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
    })),
  });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { projectId?: string; body?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const text = String(body.body ?? "").trim();
  if (!text) return Response.json({ error: "Message body is required" }, { status: 400 });
  if (text.length > MAX_BODY) {
    return Response.json({ error: `Message is too long (max ${MAX_BODY} characters)` }, { status: 400 });
  }
  const project = await projectAccess(user.id, body.projectId ?? "");
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  // Auto-create the per-project channel.
  const channel = await prisma.chatChannel.upsert({
    where: { projectId: project.id },
    update: {},
    create: { projectId: project.id, name: `${project.domain} chat` },
    select: { id: true },
  });

  // Author-name snapshot: member name, then session identity, then email prefix.
  const membership = await getMembership(user.id, project.workspaceId);
  if (!membership) return forbidden();
  const authorName =
    membership.name ??
    (user as { name?: string | null }).name ??
    user.email?.split("@")[0] ??
    "Member";

  const message = await prisma.teamChatMessage.create({
    data: { channelId: channel.id, userId: user.id, authorName, body: text },
  });
  return Response.json(
    {
      message: {
        id: message.id,
        userId: message.userId,
        authorName: message.authorName,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
      },
    },
    { status: 201 },
  );
}
