// Marketr — Wave 2 WFH mode slice 1: first-enable setup interstitial API.
// POST /api/wfh/mode/setup — completes the mandatory 60-second setup
// (wfh days, focus hours, standup cadence) and enables wfh/hybrid in the same
// call. Invalid input fails closed with 422 VALIDATION_FAILED.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import {
  validateSetupInput,
  modeIndicator,
  type SetupInput,
  type WorkModeState,
} from "@/lib/wfh/mode";

interface SetupBody extends SetupInput {
  mode?: string;
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: SetupBody;
  try {
    body = (await req.json()) as SetupBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const target = body.mode === "hybrid" ? "hybrid" : "wfh";
  const validation = validateSetupInput(body);
  if (!validation.ok || !validation.normalized) {
    return NextResponse.json(
      { error: "Setup is incomplete.", code: "VALIDATION_FAILED", details: validation.errors },
      { status: 422 },
    );
  }
  const setup = validation.normalized;

  const existing = await prisma.wfhWorkMode.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
  });
  const previousMode = (existing?.mode ?? "office") as WorkModeState["mode"];

  const updated = await prisma.wfhWorkMode.upsert({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
    create: {
      workspaceId: workspace.id,
      userId: user.id,
      email: user.email ?? null,
      mode: target,
      wfhDays: setup.wfhDays,
      focusStartMin: setup.focusStartMin,
      focusEndMin: setup.focusEndMin,
      focusBlockMinutes: setup.focusBlockMinutes,
      standupCadence: setup.standupCadence,
      notificationProfile: setup.notificationProfile,
      setupCompletedAt: new Date(),
    },
    update: {
      mode: target,
      wfhDays: setup.wfhDays,
      focusStartMin: setup.focusStartMin,
      focusEndMin: setup.focusEndMin,
      focusBlockMinutes: setup.focusBlockMinutes,
      standupCadence: setup.standupCadence,
      notificationProfile: setup.notificationProfile,
      setupCompletedAt: new Date(),
      email: user.email ?? null,
    },
  });

  await prisma.wfhModeHistory.create({
    data: {
      workspaceId: workspace.id,
      workModeId: updated.id,
      userId: user.id,
      previousMode,
      newMode: target,
      reason: "setup_interstitial",
    },
  });

  return NextResponse.json({
    mode: updated,
    indicator: modeIndicator({
      mode: updated.mode as WorkModeState["mode"],
      wfhDays: updated.wfhDays,
      setupCompletedAt: updated.setupCompletedAt,
    }),
  });
}
