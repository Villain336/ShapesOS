// ShapesOS — Phase 8: put a run's sandbox back to one of its checkpoints.
//
// Allowed only while the sandbox lives (checkpoints die with it), and only
// for a checkpoint this run (or the run that owns the shared sandbox)
// recorded on its timeline from THIS sandbox — an id from another run, or
// from a sandbox that already idled out, is refused. The route
// (app/api/agent-runs/[runId]/restore) does the authorization.

import { listAgentRunEvents, appendAgentRunEvent } from "@/lib/agents/runs/service";
import { liveSandboxForRun } from "./index";
import { SNAPSHOT_ID_RE } from "./exec-fs";

export type RestoreOutcome =
  | { ok: true; snapshotId: string; sandboxId: string }
  | { ok: false; status: 400 | 404 | 409; error: string };

interface CheckpointPayload {
  kind?: string;
  snapshotId?: string;
  sandboxId?: string;
}

async function checkpointsOf(workspaceId: string, runId: string): Promise<CheckpointPayload[]> {
  const events = await listAgentRunEvents(workspaceId, runId);
  return events
    .map((e) => (e.payload ?? {}) as CheckpointPayload)
    .filter((p) => p.kind === "sandbox.checkpoint" && typeof p.snapshotId === "string");
}

export async function restoreRunCheckpoint(input: {
  workspaceId: string;
  runId: string;
  snapshotId: unknown;
  userId: string;
}): Promise<RestoreOutcome> {
  if (typeof input.snapshotId !== "string" || !SNAPSHOT_ID_RE.test(input.snapshotId)) {
    return { ok: false, status: 400, error: "snapshotId is not a checkpoint id." };
  }
  const live = await liveSandboxForRun({ workspaceId: input.workspaceId, runId: input.runId });
  if (!live) {
    return { ok: false, status: 409, error: "This run's sandbox has ended — checkpoints can only be restored while it is running." };
  }
  const runs = live.ownerRunId === input.runId ? [input.runId] : [input.runId, live.ownerRunId];
  const known = (await Promise.all(runs.map((r) => checkpointsOf(input.workspaceId, r)))).flat();
  const cp = known.find((p) => p.snapshotId === input.snapshotId);
  if (!cp) return { ok: false, status: 404, error: "No such checkpoint on this run." };
  if (cp.sandboxId && cp.sandboxId !== live.sandbox.id) {
    return { ok: false, status: 409, error: "That checkpoint belonged to an earlier sandbox that has ended." };
  }
  await live.sandbox.restore(input.snapshotId);
  await appendAgentRunEvent(input.workspaceId, input.runId, {
    type: "note",
    summary: `Restored checkpoint ${input.snapshotId}`,
    payload: { kind: "sandbox.restored", snapshotId: input.snapshotId, sandboxId: live.sandbox.id, by: input.userId },
  }).catch(() => undefined);
  return { ok: true, snapshotId: input.snapshotId, sandboxId: live.sandbox.id };
}
