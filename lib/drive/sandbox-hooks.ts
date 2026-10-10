// ShapesOS — Phase 21B (WS=drive): when a run's sandbox has a Drive folder mounted,
// its work is synced out as Drive files "on exit and on checkpoints" (the two hooks
// are lib/sandbox/tools.ts checkpoint() and lib/sandbox/index.ts releaseRunSandbox(),
// both a single best-effort call). The sync is an AGENT sync (lib/drive/sandbox-bridge.ts):
// new files inside the run's grant are created, changed files are staged for a person,
// nothing is overwritten or deleted. What it created is put on the run's timeline as
// touched records, so "Undo this agent run" covers it.
//
// Loaded lazily from the sandbox code (the bundle-size rule): the sandbox layer must not
// statically pull in the Drive service.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { appendAgentRunEvent } from "@/lib/agents/runs/service";
import { prisma } from "@/lib/prisma";
import type { Sandbox } from "@/lib/sandbox/types";
import { syncOut, mountPathOf, type SyncReport } from "./sandbox-bridge";
import { loadGrant } from "./run-folders";

/** Sync the run's mounted folder out, if it has one. Never throws. */
export async function syncRunMount(workspaceId: string, runId: string, sandbox: Sandbox, reason: "checkpoint" | "exit"): Promise<SyncReport | null> {
  try {
    // No mount, no work (and no database read).
    const probe = await sandbox.exec(`test -f '${mountPathOf(sandbox)}/.shapes-mount.json'`, { timeoutMs: 10_000 });
    if (probe.exitCode !== 0) return null;
    const run = await withWorkspaceScope(workspaceId, (tx) => tx.agentRun.findFirst({ where: { id: runId, workspaceId }, select: { startedBy: true } }));
    if (!run) return null;
    const member = await prisma.workspaceMember.findFirst({ where: { workspaceId, userId: run.startedBy }, select: { role: true } });
    if (!member) return null;
    const actor = { workspaceId, userId: run.startedBy, role: member.role };
    const grant = await loadGrant(workspaceId, runId, run.startedBy);
    const report = await syncOut({ sandbox, actor, mode: "agent", grant });
    const changed = report.created.length + report.staged.length;
    if (changed > 0 || report.skipped.length > 0) {
      await appendAgentRunEvent(workspaceId, runId, {
        type: "note",
        summary: `Synced the mounted Drive folder (${reason}): ${report.created.length} new, ${report.staged.length} waiting for you, ${report.skipped.length} skipped`.slice(0, 280),
        payload: { kind: "tool_result", tool: "sync_drive_folder", status: "executed", touched: report.touched, report: { created: report.created, staged: report.staged, skipped: report.skipped.slice(0, 20) } },
      });
    }
    return report;
  } catch {
    return null;
  }
}
