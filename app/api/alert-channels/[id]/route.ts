// Marketr — single alert channel API (milestone 13).
// PATCH  /api/alert-channels/[id]   { name?, enabled?, config? } (config omitted = keep existing secret)
// DELETE /api/alert-channels/[id]
// Writes: admin+ (credentials). Secrets are never returned.

import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { validateChannelConfig, sealChannelConfig, auditAlertHub } from "@/lib/alerts/channels";

async function load(userId: string, workspaceId: string, id: string) {
  return prisma.alertChannel.findFirst({
    where: { id, workspaceId },
    include: { _count: { select: { rules: true } } },
  });
}

function serialize(channel: {
  id: string;
  name: string;
  type: string;
  hint: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  _count?: { rules: number };
}) {
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    hint: channel.hint,
    enabled: channel.enabled,
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
    ruleCount: channel._count?.rules ?? 0,
  };
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "admin"))) return forbidden();

  const { id } = await params;
  const channel = await load(user.id, workspace.id, id);
  if (!channel) return Response.json({ error: "Channel not found" }, { status: 404 });

  let body: { name?: string; enabled?: boolean; config?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const data: { name?: string; enabled?: boolean; configEnc?: string; hint?: string } = {};
  if (body.name !== undefined) {
    if (!body.name.trim()) return Response.json({ error: "Name cannot be empty" }, { status: 400 });
    data.name = body.name.trim().slice(0, 120);
  }
  if (body.enabled !== undefined) data.enabled = Boolean(body.enabled);
  // Empty config = keep existing secret; a provided config re-seals it.
  if (body.config !== undefined && body.config !== null) {
    const validated = validateChannelConfig(channel.type, body.config);
    if (!validated.ok) return Response.json({ error: validated.error }, { status: 400 });
    const { configEnc, hint } = sealChannelConfig(channel.type, validated.config);
    data.configEnc = configEnc;
    data.hint = hint;
  }

  const updated = await prisma.alertChannel.update({
    where: { id: channel.id },
    data,
    include: { _count: { select: { rules: true } } },
  });

  await auditAlertHub(
    workspace.id,
    "alert_channel_updated",
    `Alert channel "${updated.name}" (${updated.type}) updated`,
    `alert-channel:${updated.id}`,
    "user",
    user.id,
  ).catch(() => {});

  return Response.json({ channel: serialize(updated) });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "admin"))) return forbidden();

  const { id } = await params;
  const channel = await load(user.id, workspace.id, id);
  if (!channel) return Response.json({ error: "Channel not found" }, { status: 404 });

  await prisma.alertChannel.delete({ where: { id: channel.id } });

  await auditAlertHub(
    workspace.id,
    "alert_channel_deleted",
    `Alert channel "${channel.name}" (${channel.type}) deleted`,
    `alert-channel:${channel.id}`,
    "user",
    user.id,
  ).catch(() => {});

  return Response.json({ ok: true });
}
