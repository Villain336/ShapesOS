// Marketr — alert channel CRUD API (milestone 13: alerting hub).
// GET  /api/alert-channels            → { channels }  (secrets never returned)
// POST /api/alert-channels            { name, type, config, enabled? } → { channel } (201)
// Reads: any workspace member. Writes: admin+ (channel configs hold credentials).

import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import type { AlertChannelType } from "@prisma/client";
import { validateChannelConfig, sealChannelConfig, auditAlertHub } from "@/lib/alerts/channels";

const TYPES: AlertChannelType[] = ["slack", "telegram", "email"];

function serialize(channel: {
  id: string;
  name: string;
  type: AlertChannelType;
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

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const channels = await prisma.alertChannel.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { rules: true } } },
  });
  return Response.json({ channels: channels.map(serialize) });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  // Milestone 11 convention: credential-bearing resources are admin+.
  if (!(await requireWorkspaceRole(user.id, workspace.id, "admin"))) return forbidden();

  let body: { name?: string; type?: string; config?: unknown; enabled?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.name?.trim()) return Response.json({ error: "Name is required" }, { status: 400 });
  if (!TYPES.includes(body.type as AlertChannelType)) {
    return Response.json({ error: "type must be slack, telegram, or email" }, { status: 400 });
  }
  const type = body.type as AlertChannelType;
  const validated = validateChannelConfig(type, body.config);
  if (!validated.ok) return Response.json({ error: validated.error }, { status: 400 });
  const { configEnc, hint } = sealChannelConfig(type, validated.config);

  const channel = await prisma.alertChannel.create({
    data: {
      workspaceId: workspace.id,
      name: body.name.trim().slice(0, 120),
      type,
      configEnc,
      hint,
      enabled: body.enabled !== false,
    },
    include: { _count: { select: { rules: true } } },
  });

  await auditAlertHub(
    workspace.id,
    "alert_channel_created",
    `Alert channel "${channel.name}" (${channel.type}) created`,
    `alert-channel:${channel.id}`,
    "user",
    user.id,
  ).catch(() => {});

  return Response.json({ channel: serialize(channel) }, { status: 201 });
}
