// ShapesOS — Phase 8 (ship): a run's ship state (repo, branch, PR).
//
// Kept on AgentRun.agentState.ship — the server's record, never the
// sandbox's: the branch a run may push is read from here, so nothing the
// agent does inside the sandbox (git config, a renamed branch) can point a
// push somewhere else. git_clone writes it on the run that cloned; push and
// PR tools copy it forward onto the run they execute in (an approval runs
// as a new chat turn) with the branch and PR URLs added, so the Runs page
// shows them on whichever run you open.
//
// Lookup order for a tool call: its own run → the run that handed it work
// (sub-agent) → the newest run of the same chat thread that has one.

import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

export interface ShipState {
  /** owner/name */
  repo: string;
  /** Absolute clone directory inside the sandbox. */
  dir: string;
  defaultBranch: string;
  baseBranch: string;
  /** The commit the work started from (diffs are taken against it). */
  baseSha: string;
  /** shapes/<runId> — the ONLY branch this work may push. */
  branch: string;
  cloneRunId: string;
  mode: "app" | "pat" | "mock";
  branchUrl?: string;
  pushedSha?: string;
  pushedAt?: string;
  prNumber?: number;
  prUrl?: string;
}

export function readShipState(agentState: unknown): ShipState | null {
  const s = (agentState as { ship?: unknown } | null)?.ship as Partial<ShipState> | undefined;
  if (!s || typeof s !== "object") return null;
  if (typeof s.repo !== "string" || typeof s.branch !== "string" || typeof s.dir !== "string") return null;
  if (typeof s.baseSha !== "string" || typeof s.cloneRunId !== "string") return null;
  return s as ShipState;
}

export interface ShipLookup {
  workspaceId: string;
  runId?: string;
  threadId?: string;
}

/** Find the ship state this tool call works on (null = nothing cloned yet). */
export async function loadShipState(q: ShipLookup): Promise<ShipState | null> {
  if (!q.runId) return null;
  return withWorkspaceScope(q.workspaceId, async (tx) => {
    const run = await tx.agentRun.findFirst({
      where: { id: q.runId, workspaceId: q.workspaceId },
      select: { agentState: true, parentRunId: true, threadId: true },
    });
    if (!run) return null;
    const own = readShipState(run.agentState);
    if (own) return own;
    if (run.parentRunId) {
      const parent = await tx.agentRun.findFirst({
        where: { id: run.parentRunId, workspaceId: q.workspaceId },
        select: { agentState: true },
      });
      const p = readShipState(parent?.agentState);
      if (p) return p;
    }
    const threadId = q.threadId ?? run.threadId;
    if (!threadId) return null;
    const recent = await tx.agentRun.findMany({
      where: { workspaceId: q.workspaceId, threadId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { agentState: true },
    });
    for (const r of recent) {
      const s = readShipState(r.agentState);
      if (s) return s;
    }
    return null;
  });
}

/** Write the ship state onto a run (merged into its agentState). */
export async function saveShipState(workspaceId: string, runId: string, state: ShipState): Promise<void> {
  await withWorkspaceScope(workspaceId, async (tx) => {
    const run = await tx.agentRun.findFirst({ where: { id: runId, workspaceId }, select: { agentState: true } });
    if (!run) throw new Error("Run not found");
    const base =
      run.agentState && typeof run.agentState === "object" && !Array.isArray(run.agentState)
        ? (run.agentState as Record<string, unknown>)
        : {};
    await tx.agentRun.update({
      where: { id: runId, workspaceId },
      data: { agentState: { ...base, ship: { ...state } } as unknown as Prisma.InputJsonValue },
    });
  });
}
