// Marketr — Wave 2 WFH mode slice 5: rituals API.
// GET /api/wfh/rituals — all rituals with subscriber counts, my subscription
// state, participation history, next occurrence, and dead-ritual verdicts.
// POST /api/wfh/rituals — create a ritual (editor+).

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import {
  validateRitual,
  nextOccurrence,
  occurrencesSince,
  assessRitualHealth,
  RITUAL_TYPE_META,
  WfhRitualError,
  type RitualCadence,
  type RitualType,
} from "@/lib/wfh/rituals";

export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const now = new Date();
  const rituals = await prisma.wfhRitual.findMany({
    where: { workspaceId: workspace.id },
    include: {
      subscriptions: true,
      participations: { orderBy: { occurredAt: "desc" }, take: 20 },
    },
    orderBy: { createdAt: "asc" },
  });

  const enriched = rituals.map((r) => {
    const cadence = r.cadence as RitualCadence;
    const recent = occurrencesSince(
      r.anchorDate,
      cadence,
      new Date(now.getTime() - 90 * 24 * 3600 * 1000),
      now,
      r.timezone,
    );
    const cutoff = recent.length > 4 ? recent[recent.length - 4].getTime() : 0;
    const participationCount = r.participations.filter(
      (p) => p.occurredAt.getTime() >= cutoff,
    ).length;
    const verdict = assessRitualHealth({
      ritualId: r.id,
      anchorDate: r.anchorDate,
      cadence,
      active: r.active,
      recentOccurrences: recent,
      participationCount,
      subscriberCount: r.subscriptions.length,
    });
    return {
      id: r.id,
      type: r.type,
      meta: RITUAL_TYPE_META[r.type as RitualType] ?? null,
      title: r.title,
      description: r.description,
      cadence: r.cadence,
      anchorDate: r.anchorDate.toISOString(),
      timezone: r.timezone,
      active: r.active,
      subscriberCount: r.subscriptions.length,
      subscribed: r.subscriptions.some((s) => s.userId === user.id),
      nextOccurrence: nextOccurrence(r.anchorDate, cadence, now, r.timezone).toISOString(),
      participations: r.participations.map((p) => ({
        userId: p.userId,
        note: p.note,
        occurredAt: p.occurredAt.toISOString(),
      })),
      health: verdict,
    };
  });

  return NextResponse.json({ rituals: enriched });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const v = validateRitual({
      type: body.type as RitualType,
      title: body.title != null ? String(body.title) : null,
      description: body.description != null ? String(body.description) : null,
      cadence: body.cadence as RitualCadence | undefined,
      anchorDate: body.anchorDate ? new Date(String(body.anchorDate)) : null,
      timezone: body.timezone != null ? String(body.timezone) : null,
    });
    if (!v.ok || !v.normalized) {
      throw new WfhRitualError("VALIDATION_FAILED", "Ritual is invalid.", v.errors);
    }
    const n = v.normalized;
    const ritual = await prisma.wfhRitual.create({
      data: {
        workspaceId: workspace.id,
        createdBy: user.id,
        type: n.type,
        title: n.title,
        description: n.description,
        cadence: n.cadence,
        anchorDate: n.anchorDate,
        timezone: n.timezone,
        active: true,
      },
    });
    // The creator is opted in by default.
    await prisma.wfhRitualSubscription.create({
      data: { ritualId: ritual.id, userId: user.id },
    });
    return NextResponse.json({ ritual }, { status: 201 });
  } catch (err) {
    if (err instanceof WfhRitualError) {
      return NextResponse.json(
        { error: err.message, code: err.code, details: err.details },
        { status: 422 },
      );
    }
    throw err;
  }
}
