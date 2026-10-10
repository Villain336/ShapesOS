// ShapesOS — Phase 21B (WS=drive): the folders a person attached to an agent run
// (its grant, besides the run's own /agents/<runId> workspace). Attaching needs
// the person to be able to write to the folder themselves: a run never gets more
// than the person who started it has. lib/drive/grants.ts does the arithmetic.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { FsError } from "../filesystem/core";
import { collisionKey, normalizeFolderPath } from "../filesystem/paths";
import type { DriveActor } from "./access";
import { requireDirWrite } from "./ops";
import type { AgentGrant } from "./grants";

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The run a tool call belongs to; interactive chat (no run) gets a per-person workspace. */
export function runKey(runId: string | undefined, userId: string): string {
  const id = runId && RUN_ID_RE.test(runId) ? runId : `chat-${userId}`.slice(0, 64);
  return RUN_ID_RE.test(id) ? id : "chat";
}

export async function loadGrant(workspaceId: string, runId: string | undefined, userId: string): Promise<AgentGrant> {
  const key = runKey(runId, userId);
  const rows = runId
    ? await withWorkspaceScope(workspaceId, (tx) => tx.agentRunFolder.findMany({ where: { workspaceId, runId }, orderBy: { createdAt: "asc" }, select: { folderPath: true } }))
    : [];
  return { runId: key, folders: rows.map((r) => r.folderPath) };
}

/** Give a run a folder. The person must be able to add files to it. */
export async function attachFolderToRun(actor: DriveActor, runId: string, folderPath: string): Promise<{ folders: string[] }> {
  if (!RUN_ID_RE.test(runId)) throw new FsError("invalid_path", "Unknown run.");
  const info = normalizeFolderPath(folderPath);
  if (!info.ok) throw new FsError("invalid_path", info.reason);
  if (info.root === "/agents" || info.root === "/apps" || info.root === "/mounts") throw new FsError("invalid_path", "That folder can't be attached to a run.");
  await requireDirWrite(actor, info.path);
  return withWorkspaceScope(actor.workspaceId, async (tx) => {
    const run = await tx.agentRun.findFirst({ where: { id: runId, workspaceId: actor.workspaceId }, select: { startedBy: true } });
    if (!run) throw new FsError("not_found", "Run not found.");
    if (run.startedBy !== actor.userId && actor.role !== "admin" && actor.role !== "owner") throw new FsError("forbidden", "Only the person who started the run (or an admin) can give it folders.");
    const existing = await tx.agentRunFolder.findMany({ where: { workspaceId: actor.workspaceId, runId } });
    if (existing.length >= 20) throw new FsError("invalid_state", "A run can have up to 20 attached folders.");
    if (!existing.some((e) => collisionKey(e.folderPath) === collisionKey(info.path))) {
      await tx.agentRunFolder.create({ data: { workspaceId: actor.workspaceId, runId, folderPath: info.path, attachedBy: actor.userId } });
    }
    const all = await tx.agentRunFolder.findMany({ where: { workspaceId: actor.workspaceId, runId }, orderBy: { createdAt: "asc" } });
    return { folders: all.map((r) => r.folderPath) };
  });
}

export async function detachFolderFromRun(actor: DriveActor, runId: string, folderPath: string): Promise<{ folders: string[] }> {
  return withWorkspaceScope(actor.workspaceId, async (tx) => {
    const run = await tx.agentRun.findFirst({ where: { id: runId, workspaceId: actor.workspaceId }, select: { startedBy: true } });
    if (!run) throw new FsError("not_found", "Run not found.");
    if (run.startedBy !== actor.userId && actor.role !== "admin" && actor.role !== "owner") throw new FsError("forbidden", "Only the person who started the run (or an admin) can change its folders.");
    await tx.agentRunFolder.deleteMany({ where: { workspaceId: actor.workspaceId, runId, folderPath } });
    const all = await tx.agentRunFolder.findMany({ where: { workspaceId: actor.workspaceId, runId }, orderBy: { createdAt: "asc" } });
    return { folders: all.map((r) => r.folderPath) };
  });
}
