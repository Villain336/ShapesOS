// Marketr — Phase 9 M1: kill switches (docs/specs/SPEC-PHASE9.md §3.5).
//
// Three levels, checked by every executor entry point BEFORE anything acts:
//   1. pauseMission   — per-mission pause; running loops must check status.
//   2. freezeWorkspace — sets workspace.frozenAt; all executor entry points halt.
//   3. globalHalt     — emergency: pauses ALL active missions.
//
// resumeMission routes through staleness re-verification (SPEC §P9C):
// M1 ships the hook; M4 implements the real re-verification checklist.

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
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

/** Kill-switch check #2 for executor entry points (approvals bound to a mission).
 *  The missions table has FORCE RLS — the tenant GUC must be pinned or the
 *  query silently sees zero rows (fail-closed). */
export async function isMissionPaused(missionId: string, workspaceId: string): Promise<boolean> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const m = await tx.mission.findFirst({
      where: { id: missionId, workspaceId },
      select: { status: true },
    });
    return m?.status === "paused";
  });
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
  const m = await withWorkspaceScope(workspaceId, async (tx) => {
    const found = await tx.mission.findFirst({ where: { id: missionId, workspaceId } });
    if (!found) throw new KillSwitchError("Mission not found in workspace.");
    if (found.status === "paused") return found;
    if (found.status === "complete" || found.status === "archived") {
      throw new KillSwitchError(`Cannot pause mission in status "${found.status}".`);
    }
    await tx.mission.update({
      where: { id: missionId, workspaceId },
      data: { status: "paused" },
    });
    return found;
  });
  if (m.status === "paused") return;
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
  const m = await withWorkspaceScope(workspaceId, async (tx) => {
    const found = await tx.mission.findFirst({ where: { id: missionId, workspaceId } });
    if (!found) throw new KillSwitchError("Mission not found in workspace.");
    if (found.status !== "paused") {
      throw new KillSwitchError(`Cannot resume mission in status "${found.status}" — only paused missions resume.`);
    }
    return found;
  });
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
  await withWorkspaceScope(workspaceId, async (tx) => {
    await tx.mission.update({
      where: { id: missionId, workspaceId },
      data: { status: "active" },
    });
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
  // entry so the freeze is in the append-only trail. command_audit has FORCE
  // RLS — the GUC must be pinned for the insert to pass its WITH CHECK.
  await withWorkspaceScope(workspaceId, async (tx) => {
    await tx.commandAudit.create({
      data: {
        workspaceId,
        userId: actor,
        kind: "doAction",
        promptHash: null,
        promptFull: null,
        resultSummary: `workspace frozen${reason ? `: ${reason}` : ""}`,
      },
    });
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
  await withWorkspaceScope(workspaceId, async (tx) => {
    await tx.commandAudit.create({
      data: {
        workspaceId,
        userId: actor,
        kind: "doAction",
        resultSummary: "workspace unfrozen",
      },
    });
  });
}

/**
 * globalHalt — emergency: pauses ALL active missions across ALL workspaces.
 * Does not freeze workspaces (use freezeWorkspace per workspace for that).
 *
 * The missions table has FORCE RLS: a session without the tenant GUC sees
 * zero rows, so a single cross-workspace UPDATE would silently pause nothing.
 * Instead we enumerate workspaces (the workspaces table has no RLS) and pause
 * per workspace inside its own tenant scope. Honest and auditable.
 */
export async function globalHalt(actor = "killswitch", reason?: string): Promise<{ paused: number }> {
  const workspaces = await prisma.workspace.findMany({ select: { id: true } });
  let paused = 0;
  for (const ws of workspaces) {
    const res = await withWorkspaceScope(ws.id, async (tx) => {
      const targets = await tx.mission.findMany({
        where: { workspaceId: ws.id, status: "active" },
        select: { id: true },
      });
      for (const t of targets) {
        await tx.mission.update({ where: { id: t.id, workspaceId: ws.id }, data: { status: "paused" } });
      }
      return targets.length;
    });
    paused += res;
    if (res > 0) {
      // Workspace-level audit entry (missions have per-mission event chains;
      // the halt itself is recorded at workspace level).
      await withWorkspaceScope(ws.id, async (tx) => {
        await tx.commandAudit.create({
          data: {
            workspaceId: ws.id,
            userId: actor,
            kind: "doAction",
            resultSummary: `global halt: ${res} mission(s) paused${reason ? ` — ${reason}` : ""}`,
          },
        });
      });
    }
  }
  return { paused };
}
