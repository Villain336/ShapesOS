// ShapesOS — Phase 8: agent_run_sandboxes persistence (server-only).
//
// Every read and write goes through withWorkspaceScope(): the table is FORCE
// RLS on the app.workspace_id GUC, so another workspace's run can never see
// or reuse a sandbox. run_id is unique — one sandbox per run.

import { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

export interface SandboxRow {
  id: string;
  workspaceId: string;
  runId: string;
  provider: string;
  sandboxId: string;
  status: string;
  exposedPorts: number[];
  secretEnc: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  destroyedAt: Date | null;
}

export async function getSandboxRow(workspaceId: string, runId: string): Promise<SandboxRow | null> {
  return withWorkspaceScope(workspaceId, (tx) => tx.agentRunSandbox.findFirst({ where: { workspaceId, runId } }));
}

/** Insert the run's sandbox row; null when the run already has one (race lost). */
export async function insertSandboxRow(input: {
  workspaceId: string;
  runId: string;
  provider: string;
  sandboxId: string;
  secretEnc?: string | null;
}): Promise<SandboxRow | null> {
  try {
    return await withWorkspaceScope(input.workspaceId, (tx) =>
      tx.agentRunSandbox.create({
        data: {
          workspaceId: input.workspaceId,
          runId: input.runId,
          provider: input.provider,
          sandboxId: input.sandboxId,
          secretEnc: input.secretEnc ?? null,
        },
      }),
    );
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
    throw err;
  }
}

/**
 * Point an existing (destroyed) row at a new sandbox — a run whose sandbox
 * idled out gets a fresh one. Conditional on the row still being destroyed,
 * so two processes can't both replace it.
 */
export async function replaceSandboxRow(
  workspaceId: string,
  runId: string,
  next: { provider: string; sandboxId: string; secretEnc?: string | null },
): Promise<boolean> {
  const res = await withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRunSandbox.updateMany({
      where: { workspaceId, runId, status: "destroyed" },
      data: {
        provider: next.provider,
        sandboxId: next.sandboxId,
        secretEnc: next.secretEnc ?? null,
        status: "active",
        exposedPorts: [],
        destroyedAt: null,
        lastUsedAt: new Date(),
        createdAt: new Date(),
      },
    }),
  );
  return res.count === 1;
}

export async function touchSandboxRow(workspaceId: string, runId: string): Promise<void> {
  await withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRunSandbox.updateMany({ where: { workspaceId, runId, status: "active" }, data: { lastUsedAt: new Date() } }),
  );
}

/** Mark destroyed; true when this call made the change. Phase 15.2: the
 *  call that makes the change meters the sandbox's minutes (paid providers
 *  only, idempotent per lifetime — lib/sandbox/metering.ts). */
export async function markSandboxDestroyed(workspaceId: string, runId: string): Promise<boolean> {
  const endedAt = new Date();
  const { row, changed } = await withWorkspaceScope(workspaceId, async (tx) => {
    const before = await tx.agentRunSandbox.findFirst({
      where: { workspaceId, runId, status: "active" },
      select: { id: true, provider: true, createdAt: true, lastUsedAt: true },
    });
    const res = await tx.agentRunSandbox.updateMany({
      where: { workspaceId, runId, status: "active" },
      data: { status: "destroyed", destroyedAt: endedAt },
    });
    return { row: before, changed: res.count === 1 };
  });
  if (changed && row) {
    const { meterSandboxLifetime } = await import("./metering");
    const { sandboxConfig } = await import("./config");
    await meterSandboxLifetime({ ...row, workspaceId, runId, endedAt, idleSeconds: sandboxConfig().idleSeconds });
  }
  return changed;
}

export async function addExposedPort(workspaceId: string, runId: string, port: number): Promise<void> {
  await withWorkspaceScope(workspaceId, async (tx) => {
    const row = await tx.agentRunSandbox.findFirst({ where: { workspaceId, runId }, select: { exposedPorts: true } });
    if (!row || row.exposedPorts.includes(port)) return;
    await tx.agentRunSandbox.updateMany({
      where: { workspaceId, runId },
      data: { exposedPorts: [...row.exposedPorts, port].slice(-16) },
    });
  });
}

/** Live sandbox rows of a workspace whose run has already ended (sweeper). */
export async function listStaleSandboxRows(workspaceId: string): Promise<SandboxRow[]> {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRunSandbox.findMany({
      where: { workspaceId, status: "active", run: { status: { in: ["succeeded", "failed", "cancelled"] } } },
      take: 100,
    }),
  );
}


export interface RunLineage {
  runId: string;
  /** The top of the delegation chain (the run itself when not delegated). */
  rootRunId: string;
  /** The chat thread the run (or its root) belongs to. */
  threadId: string | null;
}

/** The run's root (delegation chain, bounded) and thread, from the database. */
export async function runLineage(workspaceId: string, runId: string): Promise<RunLineage | null> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    let cur = await tx.agentRun.findFirst({ where: { id: runId, workspaceId }, select: { id: true, parentRunId: true, threadId: true } });
    if (!cur) return null;
    let threadId = cur.threadId;
    for (let depth = 0; depth < 8 && cur.parentRunId; depth++) {
      const parent: { id: string; parentRunId: string | null; threadId: string | null } | null = await tx.agentRun.findFirst({
        where: { id: cur.parentRunId, workspaceId },
        select: { id: true, parentRunId: true, threadId: true },
      });
      if (!parent) break;
      cur = parent;
      threadId = threadId ?? parent.threadId;
    }
    return { runId, rootRunId: cur.id, threadId };
  });
}

/**
 * The sandbox rows a run may use, best first: its own, its root run's (a
 * delegated sub-agent shares the root's), then the newest live one on the
 * same chat thread (an approved "yes" runs in a NEW run on that thread and
 * must find the clone the earlier run made). Active rows only.
 */
export async function candidateSandboxRows(workspaceId: string, lineage: RunLineage): Promise<SandboxRow[]> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const ids = [...new Set([lineage.runId, lineage.rootRunId])];
    const direct = await tx.agentRunSandbox.findMany({ where: { workspaceId, status: "active", runId: { in: ids } } });
    direct.sort((a, b) => ids.indexOf(a.runId) - ids.indexOf(b.runId));
    const thread = lineage.threadId
      ? await tx.agentRunSandbox.findMany({
          where: { workspaceId, status: "active", runId: { notIn: ids }, run: { threadId: lineage.threadId } },
          orderBy: { lastUsedAt: "desc" },
          take: 3,
        })
      : [];
    return [...direct, ...thread];
  });
}

/** The newest row (any status) a run's page should show (DB only, no provider calls). */
export async function sandboxRowForRun(workspaceId: string, runId: string): Promise<SandboxRow | null> {
  const lineage = await runLineage(workspaceId, runId);
  if (!lineage) return null;
  const live = await candidateSandboxRows(workspaceId, lineage);
  if (live[0]) return live[0];
  return getSandboxRow(workspaceId, runId);
}
