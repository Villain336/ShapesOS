// ShapesOS — Phase 18.3 (WS=flow): "Undo this agent run".
//
// What a run changed comes from its own audit trail, never a guess:
//   - every executed tool call is an AgentRunEvent ("tool_result",
//     status executed) whose payload carries `touched` — the records it wrote
//     (lib/chat/tool-exec.ts; tools report them via ToolResult.touched);
//   - site drafts carry the run id (SiteRevision.runId);
//   - delegated sub-agent runs (AgentRun.parentRunId) are part of the run.
//
// planUndo() (PURE) classifies each change: revertible, or not and why:
//   note / reminder the run created      → delete it (deleteNote / removeReminder)
//   file share link it made              → revoke it (revokeShareLink)
//   Drive file it created                → move it to the Trash (only while no one has edited it since)
//   Drive file it replaced               → the earlier version comes back as a new version (only while the run's version is still current)
//   Drive file it moved                  → moved back (only if its old place is free)
//   Drive file it trashed                → restored from the Trash
//   (Not reversible: permanent removal — an agent cannot do that — and any Drive change the tool did not report as touched.)
//   ops record it updated (free update)  → patch the changed fields back to the
//                                          values in the event (opsPatch: same
//                                          checks, its own audit row)
//   site draft (draft / applied)         → discard it / restore the backup
//                                          saved before it was applied
//   money moved (spend tools, gated ops writes), messages sent, external
//   publishes, ops records it created    → listed as "can't be undone" with
//                                          the reason — never faked
//   a write with no record of what it changed → "can't be undone: unknown"
// executeUndo() reverts the revertible ones through each domain's own path,
// records the outcome on the run's timeline and in the workspace audit log
// (agent_run_undone). It is a person's action (Tier 1: the UI asks first,
// the route requires confirmed: true); only the run's starter or an admin
// may undo, and there is no agent tool for it — an agent can never undo a
// run on its own.

import type { WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { roleAtLeast } from "@/lib/authz";
import { HttpError } from "@/lib/api/errors";
import { timeMachineAudit } from "./audit";

export type UndoKind = "note" | "reminder" | "file_share" | "drive_create" | "drive_update" | "drive_move" | "drive_trash" | "ops_update" | "site_draft" | "site_applied" | "money" | "message" | "external" | "ops_create" | "read" | "unknown";

export interface UndoItem {
  /** Stable id within the plan: "<eventSeq>:<n>" or "site:<revisionId>". */
  id: string;
  kind: UndoKind;
  tool: string | null;
  label: string;
  revertible: boolean;
  /** Why not (i18n key suffix: money, message, external, created, unknown, gone). */
  reason: string | null;
  ref: { kind: string; id: string; entity?: string; fileId?: string; before?: Record<string, unknown>; siteId?: string; backupId?: string | null } | null;
  at: string | null;
}

export interface UndoPlan {
  runId: string;
  runIds: string[];
  items: UndoItem[];
  revertible: number;
  notRevertible: number;
  /** Undone already (the run's timeline says so). */
  undoneAt: string | null;
}

export interface RunEventLite {
  runId: string;
  seq: number;
  createdAt: Date;
  payload: unknown;
}

export interface SiteRevisionLite {
  id: string;
  siteId: string;
  number: number;
  status: string;
  backupId: string | null;
  runId: string | null;
}

/** Tool name → why it can't be undone (beyond the touched records). PURE. */
export function irreversibleReason(tool: string, toolKind: string | null): "money" | "message" | "external" | null {
  if (toolKind === "spend" || /(purchas|refund|payout|transfer|charge|invoice_paid|pay_)/.test(tool)) return "money";
  if (/(mail_send|send_dm|send_message|post_message|reply_in_thread|_send$|^send_|sms|slack)/.test(tool)) return "message";
  if (tool.startsWith("connector.") || toolKind === "publish" && /(publish|post|social|deploy|push)/.test(tool)) return "external";
  return null;
}

/** Classify a run's changes (PURE given its events, sites and the tool kinds). */
export function planUndo(input: {
  runId: string;
  runIds: string[];
  events: RunEventLite[];
  sites: SiteRevisionLite[];
  toolKind: (name: string) => string | null;
}): UndoPlan {
  const items: UndoItem[] = [];
  let undoneAt: string | null = null;
  for (const e of input.events) {
    const p = (e.payload ?? {}) as { kind?: string; tool?: string; status?: string; touched?: Array<Record<string, unknown>>; undo?: boolean };
    if (p.kind === "undo" || p.undo === true) {
      undoneAt = e.createdAt.toISOString();
      continue;
    }
    if (p.kind !== "tool_result" || p.status !== "executed" || typeof p.tool !== "string") continue;
    const tool = p.tool;
    const kind = input.toolKind(tool);
    const at = e.createdAt.toISOString();
    if (kind === "safe") continue; // reads change nothing
    const touched = Array.isArray(p.touched) ? p.touched : [];
    const hard = irreversibleReason(tool, kind);
    if (hard && !touched.some((t) => t.kind === "note" || t.kind === "reminder")) {
      items.push({ id: `${e.runId}:${e.seq}:0`, kind: hard, tool, label: tool, revertible: false, reason: hard, ref: null, at });
      continue;
    }
    if (touched.length === 0) {
      items.push({ id: `${e.runId}:${e.seq}:0`, kind: "unknown", tool, label: tool, revertible: false, reason: "unknown", ref: null, at });
      continue;
    }
    touched.forEach((t, n) => {
      const id = `${e.runId}:${e.seq}:${n}`;
      const ref = { kind: String(t.kind), id: String(t.id), entity: typeof t.entity === "string" ? t.entity : undefined, fileId: typeof t.fileId === "string" ? t.fileId : undefined, before: t.before && typeof t.before === "object" ? (t.before as Record<string, unknown>) : undefined };
      if (t.kind === "note" && t.op === "create") items.push({ id, kind: "note", tool, label: tool, revertible: true, reason: null, ref, at });
      else if (t.kind === "reminder" && t.op === "create") items.push({ id, kind: "reminder", tool, label: tool, revertible: true, reason: null, ref, at });
      else if (t.kind === "drive_file" && ref.before && (t.op === "create" || t.op === "update" || t.op === "move" || t.op === "trash")) {
        const dk = t.op === "create" ? "drive_create" : t.op === "update" ? "drive_update" : t.op === "move" ? "drive_move" : "drive_trash";
        items.push({ id, kind: dk, tool, label: tool, revertible: true, reason: null, ref, at });
      } else if (t.kind === "file_share") items.push({ id, kind: "file_share", tool, label: tool, revertible: true, reason: null, ref, at });
      else if (t.kind === "ops" && t.op === "update" && ref.before && ref.entity) items.push({ id, kind: "ops_update", tool, label: tool, revertible: true, reason: null, ref, at });
      else if (t.kind === "ops" && t.op === "create") items.push({ id, kind: "ops_create", tool, label: tool, revertible: false, reason: "created", ref, at });
      else items.push({ id, kind: "unknown", tool, label: tool, revertible: false, reason: "unknown", ref, at });
    });
  }
  for (const s of input.sites) {
    if (!s.runId || !input.runIds.includes(s.runId)) continue;
    if (s.status === "draft") items.push({ id: `site:${s.id}`, kind: "site_draft", tool: "site_publish_draft", label: `#${s.number}`, revertible: true, reason: null, ref: { kind: "site_revision", id: s.id, siteId: s.siteId }, at: null });
    else if (s.status === "applied") items.push({ id: `site:${s.id}`, kind: "site_applied", tool: "site_publish_draft", label: `#${s.number}`, revertible: !!s.backupId, reason: s.backupId ? null : "unknown", ref: { kind: "site_revision", id: s.id, siteId: s.siteId, backupId: s.backupId }, at: null });
  }
  const revertible = items.filter((i) => i.revertible).length;
  return { runId: input.runId, runIds: input.runIds, items, revertible, notRevertible: items.length - revertible, undoneAt };
}

export interface UndoActor {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

export class UndoError extends HttpError {}

/** The run and its delegated sub-agent runs (the tree), in this workspace. */
async function runTree(workspaceId: string, runId: string): Promise<{ run: { id: string; startedBy: string; status: string }; ids: string[] }> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const run = await tx.agentRun.findFirst({ where: { id: runId, workspaceId }, select: { id: true, startedBy: true, status: true } });
    if (!run) throw new UndoError(404, "Run not found.");
    const ids = [run.id];
    let frontier = [run.id];
    for (let depth = 0; depth < 4 && frontier.length; depth++) {
      const kids = await tx.agentRun.findMany({ where: { workspaceId, parentRunId: { in: frontier } }, select: { id: true } });
      frontier = kids.map((k) => k.id).filter((id) => !ids.includes(id));
      ids.push(...frontier);
    }
    return { run, ids };
  });
}

function mayUndo(actor: UndoActor, startedBy: string): boolean {
  return actor.userId === startedBy || roleAtLeast(actor.role, "admin");
}

/** The undo plan for a run (who may see it: its starter or an admin). */
export async function loadUndoPlan(actor: UndoActor, runId: string): Promise<UndoPlan & { canUndo: boolean; running: boolean }> {
  const { run, ids } = await runTree(actor.workspaceId, runId);
  if (!mayUndo(actor, run.startedBy) && !roleAtLeast(actor.role, "viewer")) throw new UndoError(403, "Not allowed.");
  const [events, sites] = await withWorkspaceScope(actor.workspaceId, async (tx) => [
    await tx.agentRunEvent.findMany({ where: { workspaceId: actor.workspaceId, runId: { in: ids } }, orderBy: [{ createdAt: "asc" }, { seq: "asc" }], select: { runId: true, seq: true, createdAt: true, payload: true } }),
    await tx.siteRevision.findMany({ where: { workspaceId: actor.workspaceId, runId: { in: ids } }, select: { id: true, siteId: true, number: true, status: true, backupId: true, runId: true } }),
  ] as const);
  const { getTool } = await import("@/lib/chat/tools");
  const plan = planUndo({ runId, runIds: ids, events, sites, toolKind: (n) => getTool(n)?.kind ?? (n.startsWith("connector.") ? "publish" : null) });
  return { ...plan, canUndo: mayUndo(actor, run.startedBy), running: run.status === "running" || run.status === "queued" };
}

export interface UndoOutcome {
  id: string;
  kind: UndoKind;
  result: "reverted" | "already" | "failed" | "skipped";
  error?: string;
}

/** Revert a run's revertible changes. Starter or admin, confirmed, never while the run is still going. */
export async function executeUndo(actor: UndoActor, runId: string, opts: { confirmed: boolean; itemIds?: string[] }): Promise<{ outcomes: UndoOutcome[]; plan: UndoPlan }> {
  if (!opts.confirmed) throw new UndoError(400, "Undoing a run needs your confirmation.");
  const plan = await loadUndoPlan(actor, runId);
  if (!plan.canUndo) throw new UndoError(403, "Only the person who started this run, or an admin, can undo it.");
  if (plan.running) throw new UndoError(409, "Stop the run before undoing it.");
  const run = await withWorkspaceScope(actor.workspaceId, (tx) => tx.agentRun.findFirst({ where: { id: runId, workspaceId: actor.workspaceId }, select: { startedBy: true } })).catch(() => null);
  const owner = run?.startedBy ?? actor.userId;
  const wanted = opts.itemIds?.length ? new Set(opts.itemIds) : null;
  const outcomes: UndoOutcome[] = [];
  for (const item of plan.items) {
    if (!item.revertible || (wanted && !wanted.has(item.id))) continue;
    try {
      outcomes.push({ id: item.id, kind: item.kind, result: await revertOne(actor, owner, item) });
    } catch (err) {
      outcomes.push({ id: item.id, kind: item.kind, result: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
    }
  }
  const reverted = outcomes.filter((o) => o.result === "reverted").length;
  const failed = outcomes.filter((o) => o.result === "failed").length;
  const summary = `Undo of agent run ${runId} by ${actor.userId}: ${reverted} change${reverted === 1 ? "" : "s"} reverted, ${failed} failed, ${plan.notRevertible} can't be undone`;
  const { appendAgentRunEvent } = await import("@/lib/agents/runs/service");
  await appendAgentRunEvent(actor.workspaceId, runId, { type: "note", summary, payload: { kind: "undo", undo: true, by: actor.userId, reverted, failed, notRevertible: plan.notRevertible, outcomes } }).catch(() => undefined);
  await timeMachineAudit(actor.workspaceId, "agent_run_undone", summary, actor.userId);
  return { outcomes, plan };
}

async function revertOne(actor: UndoActor, owner: string, item: UndoItem): Promise<UndoOutcome["result"]> {
  const ref = item.ref!;
  const ws = actor.workspaceId;
  switch (item.kind) {
    case "note": {
      const { deleteNote, getNote } = await import("@/lib/notes/service");
      // The note belongs to the person the agent worked for; the undoer acts with that standing.
      const noteActor = { workspaceId: ws, userId: owner, role: "owner" as WorkspaceRole };
      if (!(await getNote(noteActor, ref.id))) return "already";
      await deleteNote(noteActor, ref.id);
      return "reverted";
    }
    case "reminder": {
      const { removeReminder } = await import("@/lib/comms/reminders");
      const exists = await withWorkspaceScope(ws, (tx) => tx.opsTask.findFirst({ where: { id: ref.id, workspaceId: ws, projectId: null }, select: { assigneeId: true } }));
      if (!exists) return "already";
      await withWorkspaceScope(ws, (tx) => removeReminder(tx, { workspaceId: ws, userId: exists.assigneeId ?? owner, id: ref.id }));
      return "reverted";
    }
    case "drive_create":
    case "drive_update":
    case "drive_move":
    case "drive_trash":
      return revertDriveFile(actor, owner, item);
    case "file_share": {
      const { revokeShareLink } = await import("@/lib/files/shares");
      const link = await withWorkspaceScope(ws, (tx) => tx.workspaceFileShare.findFirst({ where: { id: ref.id, workspaceId: ws }, select: { revokedAt: true, createdBy: true, fileId: true } }));
      if (!link || link.revokedAt) return "already";
      await revokeShareLink({ workspaceId: ws, userId: link.createdBy, role: actor.role }, link.fileId, ref.id);
      return "reverted";
    }
    case "ops_update": {
      const { opsEntityDef, opsPatch } = await import("@/lib/ops/doctype");
      const { classifyOpsWrite } = await import("@/lib/ops/gate");
      const def = opsEntityDef(ref.entity!);
      const current = await withWorkspaceScope(ws, (tx) =>
        (tx as unknown as Record<string, { findFirst(a: unknown): Promise<Record<string, unknown> | null> }>)[def.delegate]!.findFirst({ where: { id: ref.id, workspaceId: ws } }),
      );
      if (!current) return "already";
      const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : (v ?? null));
      const changed = Object.entries(ref.before ?? {}).filter(([k, v]) => JSON.stringify(norm(current[k])) !== JSON.stringify(v));
      if (changed.length === 0) return "already";
      const body = { id: ref.id, ...Object.fromEntries(changed) };
      const cls = classifyOpsWrite({ entity: ref.entity!, op: "update", body });
      if (cls.mode === "gated") throw new UndoError(409, "Changing this back moves money or needs an approval, so it can't be undone here.");
      const r = await withWorkspaceScope(ws, (tx) => opsPatch(tx as never, def, { workspaceId: ws, userId: actor.userId }, body));
      if (r.outcome !== "done") throw new UndoError(409, "Changing this back needs an approval.");
      return "reverted";
    }
    case "site_draft": {
      const { discardSiteRevision } = await import("@/lib/sites/apply");
      const rev = await withWorkspaceScope(ws, (tx) => tx.siteRevision.findFirst({ where: { id: ref.id, workspaceId: ws }, select: { status: true } }));
      if (!rev || rev.status !== "draft") return "already";
      await discardSiteRevision({ workspaceId: ws, siteId: ref.siteId!, revisionId: ref.id });
      return "reverted";
    }
    case "site_applied": {
      const { applySiteRevision } = await import("@/lib/sites/apply");
      const site = await prisma.site.findFirst({ where: { id: ref.siteId!, project: { workspaceId: ws } }, select: { projectId: true } });
      if (!site) return "already";
      await applySiteRevision({ workspaceId: ws, projectId: site.projectId, siteId: ref.siteId!, revisionId: ref.backupId!, userId: actor.userId });
      return "reverted";
    }
    default:
      return "skipped";
  }
}


/**
 * Put one Drive file change back. The run acted as `owner` (the person it worked
 * for), so the file is touched with that person's standing. Each revert checks the
 * file is still as the run left it: if someone has edited, moved or replaced it
 * since, the revert is refused with a plain reason instead of destroying their work.
 */
async function revertDriveFile(actor: UndoActor, owner: string, item: UndoItem): Promise<UndoOutcome["result"]> {
  const ref = item.ref!;
  const ws = actor.workspaceId;
  const before = (ref.before ?? {}) as { version?: number; path?: string; writtenVersion?: number; movedTo?: string };
  const row = await prisma.workspaceFile.findFirst({ where: { id: ref.id, workspaceId: ws } });
  if (!row) return "already";
  const { trashFile, restoreFile, moveFile } = await import("@/lib/filesystem/service");
  const { restoreFileVersion } = await import("@/lib/filesystem/versions");
  switch (item.kind) {
    case "drive_create": {
      if (row.trashedAt) return "already";
      if (row.version > (before.version ?? 1)) throw new UndoError(409, "Someone changed this file after the agent made it, so it was left in place.");
      await trashFile({ workspaceId: ws, fileId: row.id, actorUserId: actor.userId });
      return "reverted";
    }
    case "drive_update": {
      if (row.trashedAt) throw new UndoError(409, "The file is in the Trash now; restore it first.");
      if (before.writtenVersion !== undefined && row.version !== before.writtenVersion) throw new UndoError(409, "Someone changed this file after the agent did, so it was left in place.");
      if (!before.version) return "skipped";
      await restoreFileVersion(ws, row.id, before.version, owner);
      return "reverted";
    }
    case "drive_move": {
      if (row.trashedAt) throw new UndoError(409, "The file is in the Trash now; restore it first.");
      if (!before.path) return "skipped";
      if (row.logicalPath === before.path) return "already";
      if (before.movedTo && row.logicalPath !== before.movedTo) throw new UndoError(409, "The file was moved again after the agent moved it, so it was left in place.");
      await moveFile({ workspaceId: ws, fileId: row.id, newPath: before.path, actorUserId: actor.userId });
      return "reverted";
    }
    case "drive_trash": {
      if (!row.trashedAt) return "already";
      await restoreFile({ workspaceId: ws, fileId: row.id, actorUserId: actor.userId });
      return "reverted";
    }
    default:
      return "skipped";
  }
}
