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

interface ToggleBody {
  action?: string;
  mode?: string;
  setup?: SetupInput;
}

function toState(row: {
  mode: string;
  wfhDays: string[];
  setupCompletedAt: Date | null;
} | null): WorkModeState | null {
  if (!row) return null;
  return {
    mode: row.mode as WorkModeState["mode"],
    wfhDays: row.wfhDays,
    setupCompletedAt: row.setupCompletedAt,
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
