// Marketr — Wave 2 WFH mode slice 3: focus-block enforcement API.
// POST /api/wfh/focus/[id]/enforce — run protect_focus_time.
// Body: { events?: [{ id, title, startAt, endAt }], provider?: "google"|"microsoft" }.
// Events are caller-supplied (calendar-lite): the live calendar rail is parked,
// so conflicts are checked against the provided event list. Hard protection
// enforces the NO_CALENDAR / CONSENT_REQUIRED gates before anything happens.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import {
  enforceFocusBlock,
  WfhFocusError,
  type CalendarAdapter,
  type CalendarEventLike,
  type FocusProtection,
} from "@/lib/wfh/focus";

interface EventInput {
  id?: unknown;
  title?: unknown;
  startAt?: unknown;
  endAt?: unknown;
}

function toEvent(e: EventInput, i: number): CalendarEventLike | null {
  const startAt = new Date(String(e.startAt ?? ""));
  const endAt = new Date(String(e.endAt ?? ""));
  if (isNaN(startAt.getTime()) || isNaN(endAt.getTime()) || endAt <= startAt) return null;
  return {
    id: String(e.id ?? `manual-${i}`),
    title: String(e.title ?? "Untitled event"),
    startAt,
    endAt,
  };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  let body: { events?: EventInput[]; provider?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const block = await prisma.wfhFocusBlock.findFirst({
    where: { id, workspaceId: workspace.id, userId: user.id },
  });
  if (!block) return NextResponse.json({ error: "Focus block not found" }, { status: 404 });
  if (block.status !== "scheduled" && block.status !== "overridden") {
    return NextResponse.json(
      { error: `Only scheduled or overridden blocks can be enforced (current: ${block.status}).` },
      { status: 422 },
    );
  }

  const events = (Array.isArray(body.events) ? body.events : [])
    .map(toEvent)
    .filter((e): e is CalendarEventLike => e !== null);
  const adapter: CalendarAdapter = {
    provider: "manual",
    listEvents: async (start, end) =>
      events.filter((e) => e.startAt < end && e.endAt > start),
  };

  const provider = body.provider === "microsoft" ? "microsoft" : "google";
  const connection = await prisma.wfhCalendarConnection.findUnique({
    where: { workspaceId_userId_provider: { workspaceId: workspace.id, userId: user.id, provider } },
  });

  try {
    const result = await enforceFocusBlock(
      {
        id: block.id,
        startAt: block.startAt,
        endAt: block.endAt,
        protection: block.protection as FocusProtection,
      },
      adapter,
      connection
        ? {
            provider: connection.provider as "google" | "microsoft",
            status: connection.status as "connected" | "disconnected",
            autoDeclineConsentAt: connection.autoDeclineConsentAt,
          }
        : null,
    );

    const updated = await prisma.wfhFocusBlock.update({
      where: { id: block.id },
      data: {
        status: result.newStatus,
        calendarConnectionId: connection?.id ?? null,
        defendedEventIds: result.conflicts.map((c) => c.eventId),
      },
    });

    return NextResponse.json({
      block: updated,
      enforcement: {
        ...result,
        suggestions: result.suggestions.map((s) => ({
          ...s,
          suggestedStartAt: s.suggestedStartAt.toISOString(),
          suggestedEndAt: s.suggestedEndAt.toISOString(),
        })),
      },
    });
  } catch (err) {
    if (err instanceof WfhFocusError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 422 });
    }
    throw err;
  }
}
