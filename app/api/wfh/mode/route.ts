// Marketr — Wave 2 WFH mode slice 1: mode toggle API.
// GET /api/wfh/mode — the caller's current WorkMode (null when never set).
// POST /api/wfh/mode — { action: "toggle" | "enable" | "disable", mode?, setup? }.
// Enabling wfh/hybrid enforces the setup gate: a completed setup on the row or
// valid setup input in this call, otherwise 422 SETUP_REQUIRED.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import {
  enableWfhMode,
  disableToOffice,
  toggleMode,
  modeIndicator,
  WfhModeError,
  type SetupInput,
  type WorkModeState,
} from "@/lib/wfh/mode";
import { isValidTimeZone } from "@/lib/time/zoned";

interface ToggleBody {
  action?: string;
  mode?: string;
  setup?: SetupInput;
}

function toState(row: {
  mode: string;
  wfhDays: string[];
  setupCompletedAt: Date | null;
  timezone?: string | null;
} | null): WorkModeState | null {
  if (!row) return null;
  return {
    mode: row.mode as WorkModeState["mode"],
    wfhDays: row.wfhDays,
    setupCompletedAt: row.setupCompletedAt,
    timezone: row.timezone ?? null,
  };
}

export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const row = await prisma.wfhWorkMode.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
  });
  return NextResponse.json({ mode: row, indicator: modeIndicator(toState(row)) });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: ToggleBody;
  try {
    body = (await req.json()) as ToggleBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const row = await prisma.wfhWorkMode.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
  });
  const current = toState(row);
  const action = body.action ?? "toggle";

  try {
    const transition =
      action === "enable"
        ? enableWfhMode(current, body.mode === "hybrid" ? "hybrid" : "wfh", body.setup)
        : action === "disable"
          ? disableToOffice(current)
          : toggleMode(current, body.setup);

    const setup = transition.setup;
    const updated = await prisma.wfhWorkMode.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
      create: {
        workspaceId: workspace.id,
        userId: user.id,
        email: user.email ?? null,
        mode: transition.newMode,
        wfhDays: setup?.wfhDays ?? [],
        focusStartMin: setup?.focusStartMin ?? 540,
        focusEndMin: setup?.focusEndMin ?? 1020,
        focusBlockMinutes: setup?.focusBlockMinutes ?? 90,
        standupCadence: setup?.standupCadence ?? "daily",
        notificationProfile: setup?.notificationProfile ?? "batched",
        ...(setup?.timezone ? { timezone: setup.timezone } : {}),
        setupCompletedAt: setup ? new Date() : null,
      },
      update: {
        mode: transition.newMode,
        ...(setup
          ? {
              wfhDays: setup.wfhDays,
              focusStartMin: setup.focusStartMin,
              focusEndMin: setup.focusEndMin,
              focusBlockMinutes: setup.focusBlockMinutes,
              standupCadence: setup.standupCadence,
              notificationProfile: setup.notificationProfile,
              ...(setup.timezone ? { timezone: setup.timezone } : {}),
              setupCompletedAt: new Date(),
            }
          : {}),
        email: user.email ?? null,
      },
    });

    await prisma.wfhModeHistory.create({
      data: {
        workspaceId: workspace.id,
        workModeId: updated.id,
        userId: user.id,
        previousMode: transition.previousMode,
        newMode: transition.newMode,
        reason: transition.reason,
      },
    });

    return NextResponse.json({ mode: updated, indicator: modeIndicator(toState(updated)) });
  } catch (err) {
    if (err instanceof WfhModeError) {
      return NextResponse.json(
        { error: err.message, code: err.code, details: err.details },
        { status: 422 },
      );
    }
    throw err;
  }
}

/**
 * PATCH /api/wfh/mode — update WFH preferences without changing the mode.
 * Body: { digestTimesMin?: number[], notificationProfile?: "realtime"|"batched",
 *         timezone?: IANA name }.
 */
export async function PATCH(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { digestTimesMin?: unknown; notificationProfile?: unknown; timezone?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const patch: { digestTimesMin?: number[]; notificationProfile?: "realtime" | "batched"; timezone?: string } = {};
  if (body.digestTimesMin !== undefined) {
    const times = Array.isArray(body.digestTimesMin) ? body.digestTimesMin : [];
    const clean = [
      ...new Set(
        times.filter(
          (t): t is number => typeof t === "number" && Number.isInteger(t) && t >= 0 && t < 1440,
        ),
      ),
    ].sort((a, b) => a - b);
    if (clean.length === 0 || clean.length > 6) {
      return NextResponse.json(
        { error: "Provide 1–6 digest times as minutes since midnight." },
        { status: 400 },
      );
    }
    patch.digestTimesMin = clean;
  }
  if (body.notificationProfile !== undefined) {
    if (body.notificationProfile !== "realtime" && body.notificationProfile !== "batched") {
      return NextResponse.json(
        { error: "notificationProfile must be 'realtime' or 'batched'." },
        { status: 400 },
      );
    }
    patch.notificationProfile = body.notificationProfile;
  }
  if (body.timezone !== undefined) {
    if (!isValidTimeZone(body.timezone)) {
      return NextResponse.json(
        { error: "timezone must be an IANA name such as America/New_York." },
        { status: 400 },
      );
    }
    patch.timezone = body.timezone;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  const updated = await prisma.wfhWorkMode.upsert({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
    create: {
      workspaceId: workspace.id,
      userId: user.id,
      email: user.email ?? null,
      mode: "office",
      ...patch,
    },
    update: { ...patch, email: user.email ?? null },
  });
  return NextResponse.json({ mode: updated });
}
