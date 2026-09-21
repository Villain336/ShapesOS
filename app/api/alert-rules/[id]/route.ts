// Marketr — single alert rule API (milestone 13).
// PATCH  /api/alert-rules/[id]   (partial update; channelIds replaces channel set)
// DELETE /api/alert-rules/[id]
// Writes: editor+.

import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { triggerDef } from "@/lib/alerts/triggers";
import { auditAlertHub } from "@/lib/alerts/channels";
import { validateRuleBody, type RuleBody } from "../route";
import { Prisma } from "@prisma/client";

const INCLUDE = {
  channels: { select: { id: true, name: true, type: true, hint: true, enabled: true } },
  _count: { select: { events: true } },
} as const;

function serialize(rule: {
  id: string;
  name: string;
  trigger: string;
  conditions: unknown;
  cooldownSec: number;
  digest: string;
  quietHours: unknown;
  enabled: boolean;
  lastFiredAt: Date | null;
  lastDigestAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  channels: { id: string; name: string; type: string; hint: string; enabled: boolean }[];
  _count?: { events: number };
}) {
  return {
    id: rule.id,
    name: rule.name,
    trigger: rule.trigger,
    triggerLabel: triggerDef(rule.trigger)?.label ?? rule.trigger,
    conditions: rule.conditions ?? {},
    cooldownSec: rule.cooldownSec,
    digest: rule.digest,
    quietHours: rule.quietHours ?? null,
    enabled: rule.enabled,
    lastFiredAt: rule.lastFiredAt?.toISOString() ?? null,
    lastDigestAt: rule.lastDigestAt?.toISOString() ?? null,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
    channels: rule.channels.map((c) => ({ id: c.id, name: c.name, type: c.type, hint: c.hint, enabled: c.enabled })),
    eventCount: rule._count?.events ?? 0,
  };
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  const { id } = await params;
  const rule = await prisma.alertRule.findFirst({ where: { id, workspaceId: workspace.id } });
  if (!rule) return Response.json({ error: "Rule not found" }, { status: 404 });

  let body: RuleBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const validated = await validateRuleBody(workspace.id, body, true);
  if (!validated.ok) return Response.json({ error: validated.error }, { status: 400 });
  const d = validated.data;

  const updated = await prisma.alertRule.update({
    where: { id: rule.id },
    data: {
      ...(d.name !== undefined ? { name: d.name as string } : {}),
      ...(d.trigger !== undefined ? { trigger: d.trigger as string } : {}),
      ...(d.conditions !== undefined ? { conditions: d.conditions as object } : {}),
      ...(d.cooldownSec !== undefined ? { cooldownSec: d.cooldownSec as number } : {}),
      ...(d.digest !== undefined ? { digest: d.digest as string } : {}),
      ...(d.quietHours !== undefined
        ? { quietHours: d.quietHours === null ? Prisma.JsonNull : (d.quietHours as Prisma.InputJsonValue) }
        : {}),
      ...(d.enabled !== undefined ? { enabled: d.enabled as boolean } : {}),
      ...(d.channelIds !== undefined
        ? { channels: { set: (d.channelIds as string[]).map((cid) => ({ id: cid })) } }
        : {}),
    },
    include: INCLUDE,
  });

  await auditAlertHub(
    workspace.id,
    "alert_rule_updated",
    `Alert rule "${updated.name}" (${updated.trigger}) updated`,
    `alert-rule:${updated.id}`,
    "user",
    user.id,
  ).catch(() => {});

  return Response.json({ rule: serialize(updated) });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  const { id } = await params;
  const rule = await prisma.alertRule.findFirst({ where: { id, workspaceId: workspace.id } });
  if (!rule) return Response.json({ error: "Rule not found" }, { status: 404 });

  await prisma.alertRule.delete({ where: { id: rule.id } });

  await auditAlertHub(
    workspace.id,
    "alert_rule_deleted",
    `Alert rule "${rule.name}" (${rule.trigger}) deleted`,
    `alert-rule:${rule.id}`,
    "user",
    user.id,
  ).catch(() => {});

  return Response.json({ ok: true });
}
