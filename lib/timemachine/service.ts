// ShapesOS — Phase 18.3 (WS=flow): Time Machine's front door. Snapshots and
// restore are ADMIN+ (they read / copy everything the workspace owns); the
// version history hub and "Undo this agent run" have their own rules
// (./versions.ts, ./undo.ts). Routes call these; they re-check the role.

import type { WorkspaceRole } from "@prisma/client";
import { roleAtLeast } from "@/lib/authz";
import {
  createSnapshot,
  deleteSnapshot,
  getSnapshotSettings,
  listSnapshots,
  readSnapshotBytes,
  setSnapshotSettings,
  SnapshotError,
  type SnapshotSettings,
  type SnapshotView,
} from "./snapshots";
import { restoreSnapshot, type RestoreReport } from "./restore";
import { timeMachineAudit } from "./audit";

export interface TimeMachineActor {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

function assertAdmin(actor: TimeMachineActor): void {
  if (!roleAtLeast(actor.role, "admin")) throw new SnapshotError(403, "Only workspace admins can use snapshots.");
}

export async function tmOverview(actor: TimeMachineActor): Promise<{ settings: SnapshotSettings; snapshots: SnapshotView[] }> {
  assertAdmin(actor);
  const [settings, snapshots] = await Promise.all([getSnapshotSettings(actor.workspaceId), listSnapshots(actor.workspaceId)]);
  return { settings, snapshots };
}

export async function tmTakeSnapshot(actor: TimeMachineActor): Promise<SnapshotView> {
  assertAdmin(actor);
  return createSnapshot({ workspaceId: actor.workspaceId, userId: actor.userId, trigger: "manual" });
}

export async function tmSaveSettings(actor: TimeMachineActor, input: { schedule?: unknown; retention?: unknown }): Promise<SnapshotSettings> {
  assertAdmin(actor);
  return setSnapshotSettings(actor.workspaceId, actor.userId, input);
}

export async function tmDeleteSnapshot(actor: TimeMachineActor, id: string): Promise<void> {
  assertAdmin(actor);
  await deleteSnapshot(actor.workspaceId, id, actor.userId);
}

export async function tmDownload(actor: TimeMachineActor, id: string): Promise<{ view: SnapshotView; bytes: Buffer }> {
  assertAdmin(actor);
  const got = await readSnapshotBytes(actor.workspaceId, id);
  if (!got) throw new SnapshotError(404, "That snapshot isn't available.");
  await timeMachineAudit(actor.workspaceId, "snapshot_downloaded", `Time Machine snapshot ${id} downloaded`, actor.userId);
  return got;
}

export async function tmRestore(actor: TimeMachineActor, id: string, name?: string | null): Promise<RestoreReport> {
  assertAdmin(actor);
  return restoreSnapshot({ workspaceId: actor.workspaceId, snapshotId: id, userId: actor.userId, name });
}
