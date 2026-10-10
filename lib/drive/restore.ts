// ShapesOS — Phase 21B (WS=drive): "restore this folder as of <time>" — per-file
// point-in-time, beside the whole-workspace Time Machine. Facts come from the
// version history (workspace_file_versions) and the change journal (moves and
// trashing after the time); lib/drive/restore-plan.ts decides what to do and is
// pure. A restore writes the old bytes as NEW versions in the same folder, brings
// back files that were trashed since, and NEVER deletes anything. The dry run (the
// default) returns the plan and changes nothing.

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { NotFoundError } from "@/lib/api/errors";
import { FsError } from "../filesystem/core";
import { collisionKey, normalizeFolderPath } from "../filesystem/paths";
import { restoreFile } from "../filesystem/service";
import { restoreFileVersion } from "../filesystem/versions";
import { fileCan } from "../files/acl";
import { driveRoleFor, type DriveActor } from "./access";
import { planRestoreAsOf, type RestoreFileFacts, type RestoreItem, type RestorePlan } from "./restore-plan";

const MAX_FILES = 5000;

export interface RestoreRequest {
  actor: DriveActor;
  /** Folder (display or stored path). */
  folder: string;
  asOf: Date;
  /** false (default) = the plan only. */
  apply?: boolean;
}

export interface RestoreOutcome {
  fileId: string;
  path: string;
  action: RestoreItem["action"];
  result: "restored" | "untrashed" | "skipped" | "failed";
  error?: string;
  newVersion?: number;
}

export interface RestoreReport {
  plan: RestorePlan;
  applied: boolean;
  outcomes: RestoreOutcome[];
}

export async function restoreFolderAsOf(req: RestoreRequest): Promise<RestoreReport> {
  const { actor } = req;
  if (!(req.asOf instanceof Date) || Number.isNaN(req.asOf.getTime())) throw new FsError("invalid_path", "Pick a valid time.");
  if (req.asOf.getTime() > Date.now()) throw new FsError("invalid_path", "That time is in the future.");
  const info = normalizeFolderPath(req.folder);
  if (!info.ok) throw new FsError("invalid_path", info.reason);
  const ws = actor.workspaceId;
  const role = await driveRoleFor(actor, { path: info.path, ownerUserId: info.ownerUserId, createdBy: null });
  if (!role) throw new NotFoundError("Folder not found.");
  if (req.apply && !fileCan(role, "edit")) throw new FsError("forbidden", "Restoring a folder needs edit access to it.");
  const prefix = `${info.path}/`;
  const visible = [{ ownerUserId: null }, { ownerUserId: actor.userId }];

  // Files that are in the folder now (live or trashed) ...
  const inFolder = await prisma.workspaceFile.findMany({ where: { workspaceId: ws, logicalPath: { startsWith: prefix }, OR: visible }, take: MAX_FILES + 1 });
  // ... and files that were in it at the time but have moved out since.
  const movedOut = await withWorkspaceScope(ws, (tx) =>
    tx.workspaceDriveChange.findMany({ where: { workspaceId: ws, entity: "file", type: "move", createdAt: { gt: req.asOf }, prevPath: { startsWith: prefix } }, select: { entityId: true } }),
  );
  const extra = movedOut.length
    ? await prisma.workspaceFile.findMany({ where: { workspaceId: ws, id: { in: [...new Set(movedOut.map((m) => m.entityId))].filter((id) => !inFolder.some((f) => f.id === id)) }, OR: visible } })
    : [];
  const files = [...inFolder, ...extra];
  if (files.length > MAX_FILES) throw new FsError("too_large", `That folder has more than ${MAX_FILES} files; restore a subfolder.`);
  const ids = files.map((f) => f.id);

  const [versions, events] = await withWorkspaceScope(ws, async (tx) => [
    await tx.workspaceFileVersion.findMany({ where: { workspaceId: ws, fileId: { in: ids } }, orderBy: { version: "asc" } }),
    await tx.workspaceDriveChange.findMany({ where: { workspaceId: ws, entity: "file", entityId: { in: ids } }, orderBy: { seq: "asc" }, select: { entityId: true, type: true, prevPath: true, createdAt: true } }),
  ] as const);
  const vByFile = new Map<string, typeof versions>();
  for (const v of versions) vByFile.set(v.fileId, [...(vByFile.get(v.fileId) ?? []), v]);
  const eByFile = new Map<string, typeof events>();
  for (const e of events) eByFile.set(e.entityId, [...(eByFile.get(e.entityId) ?? []), e]);

  const facts: RestoreFileFacts[] = [];
  for (const f of files) {
    const prev = vByFile.get(f.id) ?? [];
    const lastReplaced = prev.length ? prev[prev.length - 1]!.replacedAt : null;
    const timeline = [
      ...prev.map((v) => ({ version: v.version, from: v.createdAt, until: v.replacedAt as Date | null })),
      { version: f.version, from: lastReplaced ?? f.createdAt, until: null as Date | null },
    ];
    const ev = eByFile.get(f.id) ?? [];
    const before = ev.filter((e) => e.createdAt <= req.asOf && (e.type === "trash" || e.type === "restore" || e.type === "create"));
    const lastBefore = before[before.length - 1];
    const trashedAsOf = lastBefore ? lastBefore.type === "trash" : !!f.trashedAt && f.trashedAt <= req.asOf;
    const movedAfter = ev.filter((e) => e.type === "move" && e.createdAt > req.asOf && e.prevPath).map((e) => ({ at: e.createdAt, fromPath: e.prevPath! }));
    let livePathTaken = false;
    if (f.trashedAt) {
      const clash = await prisma.workspaceFile.findFirst({ where: { workspaceId: ws, trashedAt: null, id: { not: f.id }, OR: [{ pathKey: collisionKey(f.logicalPath) }, { pathKey: null, logicalPath: { equals: f.logicalPath, mode: "insensitive" } }] }, select: { id: true } });
      livePathTaken = !!clash;
    }
    facts.push({ id: f.id, currentPath: f.logicalPath, createdAt: f.createdAt, currentVersion: f.version, trashedNow: !!f.trashedAt, trashedAsOf, movedAfter, livePathTaken, versions: timeline });
  }

  const plan = planRestoreAsOf({ folder: info.path, asOf: req.asOf, files: facts });
  if (!req.apply) return { plan, applied: false, outcomes: [] };

  const outcomes: RestoreOutcome[] = [];
  for (const item of plan.items) {
    const base = { fileId: item.fileId, path: item.path, action: item.action };
    if (item.action !== "restore_version" && item.action !== "untrash") {
      outcomes.push({ ...base, result: "skipped" });
      continue;
    }
    try {
      const frole = await driveRoleFor(actor, { path: item.path, ownerUserId: files.find((f) => f.id === item.fileId)?.ownerUserId ?? null, createdBy: files.find((f) => f.id === item.fileId)?.createdBy ?? null, fileId: item.fileId });
      if (!frole || !fileCan(frole, "version")) throw new FsError("forbidden", "Your access to this file doesn't allow restoring it.");
      if (item.untrash) await restoreFile({ workspaceId: ws, fileId: item.fileId, actorUserId: actor.userId });
      if (item.toVersion !== null) {
        const r = await restoreFileVersion(ws, item.fileId, item.toVersion, actor.userId);
        outcomes.push({ ...base, result: item.untrash ? "untrashed" : "restored", newVersion: r.version });
      } else {
        outcomes.push({ ...base, result: "untrashed" });
      }
    } catch (err) {
      outcomes.push({ ...base, result: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { plan, applied: true, outcomes };
}
