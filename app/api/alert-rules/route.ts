// Marketr — alert rule CRUD API (milestone 13: alerting hub).
// GET  /api/alert-rules   → { rules } (with channels + trigger catalog)
// POST /api/alert-rules   { name, trigger, conditions?, cooldownSec?, digest?, quietHours?, channelIds, enabled? }
// Reads: any workspace member. Writes: editor+.

import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { TRIGGERS, triggerDef } from "@/lib/alerts/triggers";
import { auditAlertHub } from "@/lib/alerts/channels";
import { Prisma } from "@prisma/client";

const DIGESTS = ["immediate", "daily_digest"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

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

export interface RuleBody {
  name?: string;
  trigger?: string;
  conditions?: Record<string, unknown>;
  cooldownSec?: number;
  digest?: string;
  quietHours?: { start?: string; end?: string } | null;
  channelIds?: string[];
  enabled?: boolean;
}

/** Validate + normalize a rule body. Returns error string or normalized data. */
export async function validateRuleBody(
  workspaceId: string,
  body: RuleBody,
  partial = false,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  const data: Record<string, unknown> = {};

  if (body.name !== undefined || !partial) {
    if (!body.name?.trim()) return { ok: false, error: "Name is required" };
    data.name = body.name.trim().slice(0, 120);
  }
  if (body.trigger !== undefined || !partial) {
    if (!triggerDef(String(body.trigger ?? ""))) {
      return { ok: false, error: `trigger must be one of: ${TRIGGERS.map((t) => t.key).join(", ")}` };
    }
    data.trigger = body.trigger;
  }
  if (body.conditions !== undefined) {
    if (typeof body.conditions !== "object" || body.conditions === null || Array.isArray(body.conditions)) {
      return { ok: false, error: "conditions must be an object" };
    }
    const c = body.conditions as Record<string, unknown>;
    if (c.thresholdPositions !== undefined && (typeof c.thresholdPositions !== "number" || c.thresholdPositions < 1)) {
      return { ok: false, error: "conditions.thresholdPositions must be a positive number" };
    }
    data.conditions = c;
  }
  if (body.cooldownSec !== undefined) {
    const s = Math.round(Number(body.cooldownSec));
    if (!Number.isFinite(s) || s < 0) return { ok: false, error: "cooldownSec must be >= 0" };
    data.cooldownSec = Math.min(s, 7 * 24 * 3600);
  }
  if (body.digest !== undefined) {
    if (!DIGESTS.includes(body.digest)) return { ok: false, error: "digest must be immediate or daily_digest" };
    data.digest = body.digest;
  }
  if (body.quietHours !== undefined) {
    const qh = body.quietHours;
    if (qh !== null && (typeof qh !== "object" || !HHMM.test(String(qh.start ?? "")) || !HHMM.test(String(qh.end ?? "")))) {
      return { ok: false, error: 'quietHours must be null or { start: "HH:MM", end: "HH:MM" } (UTC)' };
    }
    data.quietHours = qh;
  }
  if (body.enabled !== undefined) data.enabled = Boolean(body.enabled);
  if (body.channelIds !== undefined) {
    if (!Array.isArray(body.channelIds) || body.channelIds.length === 0) {
      return { ok: false, error: "channelIds must be a non-empty array" };
    }
    const count = await prisma.alertChannel.count({
      where: { id: { in: body.channelIds }, workspaceId },
    });
    if (count !== body.channelIds.length) {
      return { ok: false, error: "one or more channels do not exist in this workspace" };
    }
    data.channelIds = body.channelIds;
  }

  return { ok: true, data };
}

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const rules = await prisma.alertRule.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "asc" },
    include: {
      channels: { select: { id: true, name: true, type: true, hint: true, enabled: true } },
      _count: { select: { events: true } },
    },
  });
  return Response.json({ rules: rules.map(serialize), triggers: TRIGGERS });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  let body: RuleBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const validated = await validateRuleBody(workspace.id, body);
  if (!validated.ok) return Response.json({ error: validated.error }, { status: 400 });
  const d = validated.data;
  if (!d.channelIds) return Response.json({ error: "channelIds is required" }, { status: 400 });

  const rule = await prisma.alertRule.create({
    data: {
      workspaceId: workspace.id,
      name: d.name as string,
      trigger: d.trigger as string,
      conditions: (d.conditions ?? {}) as object,
      cooldownSec: (d.cooldownSec as number | undefined) ?? 3600,
      digest: (d.digest as string | undefined) ?? "immediate",
      ...(d.quietHours !== undefined
        ? { quietHours: d.quietHours === null ? Prisma.JsonNull : (d.quietHours as Prisma.InputJsonValue) }
        : {}),
      enabled: d.enabled !== false,
      channels: { connect: (d.channelIds as string[]).map((id) => ({ id })) },
    },
    include: {
      channels: { select: { id: true, name: true, type: true, hint: true, enabled: true } },
      _count: { select: { events: true } },
    },
  });

  await auditAlertHub(
    workspace.id,
    "alert_rule_created",
    `Alert rule "${rule.name}" (${rule.trigger}) created`,
    `alert-rule:${rule.id}`,
    "user",
    user.id,
  ).catch(() => {});

  return Response.json({ rule: serialize(rule) }, { status: 201 });
}
