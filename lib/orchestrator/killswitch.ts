// Marketr — Phase 9 M1: kill switches (SPEC-PHASE9.md §3.5).
//
// Three levels, checked by every executor entry point BEFORE anything acts:
//   1. pauseMission   — per-mission pause; running loops must check status.
//   2. freezeWorkspace — sets workspace.frozenAt; all executor entry points halt.
//   3. globalHalt     — emergency: pauses ALL active missions.
//
// resumeMission routes through staleness re-verification (SPEC §P9C):
// M1 ships the hook; M4 implements the real re-verification checklist.

import { prisma } from "@/lib/prisma";
import { appendMissionEvent } from "./audit";

export class KillSwitchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KillSwitchError";
  }
}

export interface StalenessCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface StalenessReport {
  fresh: boolean;
  checkedAt: string;
  checks: StalenessCheck[];
  note?: string;
}

/** Default M1 stub — M4 implements the real checklist (budgets, data
 *  freshness, assumptions per mission type). The stub passes so pause/resume
 *  round-trips work; M4 replaces it with a real verifier. */
export async function defaultStalenessVerification(): Promise<StalenessReport> {
  return {
    fresh: true,
    checkedAt: new Date().toISOString(),
    checks: [],
    note: "M1 stub — M4 implements the resume re-verification checklist.",
  };
}

/** Kill-switch check #1 for executor entry points. */
export async function isWorkspaceFrozen(workspaceId: string): Promise<boolean> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { frozenAt: true },
  });
  return ws?.frozenAt != null;
}

/** Kill-switch check #2 for executor entry points (approvals bound to a mission). */
export async function isMissionPaused(missionId: string, workspaceId: string): Promise<boolean> {
  const m = await prisma.mission.findFirst({
    where: { id: missionId, workspaceId },
    select: { status: true },
  });
  return m?.status === "paused";
}

/**
 * pauseMission — status -> paused. Running loops must check status before
 * each step (M2). Idempotent: already-paused is a no-op.
 */
export async function pauseMission(
  missionId: string,
  workspaceId: string,
  actor = "killswitch",
): Promise<void> {
  const m = await prisma.mission.findFirst({ where: { id: missionId, workspaceId } });
  if (!m) throw new KillSwitchError("Mission not found in workspace.");
  if (m.status === "paused") return;
  if (m.status === "complete" || m.status === "archived") {
    throw new KillSwitchError(`Cannot pause mission in status "${m.status}".`);
  }
  await prisma.mission.update({
    where: { id: missionId },
    data: { status: "paused" },
  });
  await appendMissionEvent({
    missionId,
    workspaceId,
    actor,
    step: "killswitch.pause",
    observation: { from: m.status, to: "paused" },
  });
}

/**
 * resumeMission — paused -> active, but ONLY after staleness re-verification
 * (SPEC §P9C). Pass a real verifier in M4; the M1 stub passes with a note.
 */
export async function resumeMission(
  missionId: string,
  workspaceId: string,
  opts: {
    actor?: string;
    verifyStaleness?: () => Promise<StalenessReport>;
  } = {},
): Promise<StalenessReport> {
  const m = await prisma.mission.findFirst({ where: { id: missionId, workspaceId } });
  if (!m) throw new KillSwitchError("Mission not found in workspace.");
  if (m.status !== "paused") {
    throw new KillSwitchError(`Cannot resume mission in status "${m.status}" — only paused missions resume.`);
  }
  const verify = opts.verifyStaleness ?? defaultStalenessVerification;
  const report = await verify();
  if (!report.fresh) {
    await appendMissionEvent({
      missionId,
      workspaceId,
      actor: opts.actor ?? "killswitch",
      step: "killswitch.resume_blocked",
      observation: { report },
    });
    throw new KillSwitchError(
      `Staleness re-verification FAILED — mission stays paused. Failed checks: ${report.checks
        .filter((c) => !c.ok)
        .map((c) => c.name)
        .join(", ")}`,
    );
  }
  await prisma.mission.update({
    where: { id: missionId },
    data: { status: "active" },
  });
  await appendMissionEvent({
    missionId,
    workspaceId,
    actor: opts.actor ?? "killswitch",
    step: "killswitch.resume",
    observation: { stalenessReport: report },
  });
  return report;
}

/**
 * freezeWorkspace — sets workspace.frozenAt. Every executor entry point
 * checks this FIRST and halts while set. Idempotent.
 */
export async function freezeWorkspace(
  workspaceId: string,
  actor = "killswitch",
  reason?: string,
): Promise<void> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!ws) throw new KillSwitchError("Workspace not found.");
  if (ws.frozenAt) return;
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { frozenAt: new Date() },
  });
  // Workspace-level event (no mission context): recorded as a command-audit
  // entry so the freeze is in the append-only trail.
  await prisma.commandAudit.create({
    data: {
      workspaceId,
      userId: actor,
      kind: "doAction",
      promptHash: null,
      promptFull: null,
      resultSummary: `workspace frozen${reason ? `: ${reason}` : ""}`,
    },
  });
}

/** unfreezeWorkspace — clears frozenAt. Executor entry points run again. */
export async function unfreezeWorkspace(workspaceId: string, actor = "killswitch"): Promise<void> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!ws) throw new KillSwitchError("Workspace not found.");
  if (!ws.frozenAt) return;
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { frozenAt: null },
  });
  await prisma.commandAudit.create({
    data: {
      workspaceId,
      userId: actor,
      kind: "doAction",
      resultSummary: "workspace unfrozen",
    },
  });
}

/**
 * globalHalt — emergency: pauses ALL active missions across ALL workspaces.
 * Does not freeze workspaces (use freezeWorkspace per workspace for that).
 */
export async function globalHalt(actor = "killswitch", reason?: string): Promise<{ paused: number }> {
  const res = await prisma.mission.updateMany({
    where: { status: "active" },
    data: { status: "paused" },
  });
  return { paused: res.count };
}
