// ShapesOS — Phase 3 (J): notification producers.
//
// Called from the places where something happens (an approval is requested
// or decided, an alert fires, an agent run fails, an invite is accepted).
// Every producer is BEST-EFFORT: it resolves recipients from the workspace
// membership, writes one row per recipient (idempotent through dedupKey),
// and never throws — a notification failure must never fail the action
// that triggered it. Call it after the action's own transaction commits.

import type { Prisma, WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { INBOX_SOURCE_LABELS, type InboxSourceKey } from "@/lib/approvals/types";
import { createNotifications, safeHref, type NotificationInput } from "./store";
// Phase 4a: outbound webhooks hang off the same producer seam (best-effort,
// never throws — see lib/webhooks/emit.ts).
import { emitWebhookEvent } from "@/lib/webhooks/emit";
// Phase 4b: mobile push for the push kinds (fire-and-forget, no-op unless
// PUSH_PROVIDER=expo — see lib/push/notify.ts).
import { queuePushForNotifications } from "@/lib/push/notify";

export type ProducerDb = Pick<Prisma.TransactionClient, "notification" | "workspaceMember" | "workspace">;

// Same ranks as lib/authz ROLE_RANK — kept local so lib/authz can import the
// producers statically without an import cycle.
const ROLE_RANK: Record<WorkspaceRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

/** Upper bound on fan-out per event (large workspaces get the most senior first). */
const MAX_RECIPIENTS = 100;

function defaultDb(): ProducerDb {
  return prisma as unknown as ProducerDb;
}

function warn(producer: string, err: unknown) {
  // Best-effort by design: log and move on.
  console.warn(`[notifications] ${producer} skipped:`, err instanceof Error ? err.message : err);
}

/** A raw actor string ("<userId>", "<userId> (playbook:…)") → user id candidate. */
export function actorUserId(actor: string | null | undefined): string | null {
  if (typeof actor !== "string") return null;
  const first = actor.trim().split(/\s+/)[0] ?? "";
  if (!first || first.includes("@") || first.includes(":") || first === "system") return null;
  return first;
}

/**
 * Insert notifications, then emit one `notification.created` webhook per
 * recipient row (Phase 4a). The webhook dedupe key follows the
 * notification's own, so a duplicate notification never re-fires.
 */
async function createAndEmit(db: ProducerDb, inputs: NotificationInput[]): Promise<number> {
  const created = await createNotifications(db, inputs);
  if (created > 0) {
    queuePushForNotifications(inputs);
    for (const n of inputs) {
      await emitWebhookEvent({
        workspaceId: n.workspaceId,
        type: "notification.created",
        data: {
          kind: n.kind,
          userId: n.userId,
          title: n.title,
          body: n.body ?? null,
          href: safeHref(n.href),
          sourceType: n.sourceType ?? null,
          sourceId: n.sourceId ?? null,
        },
        dedupKey: n.dedupKey ? `notification:${n.userId}:${n.dedupKey}` : null,
      });
    }
  }
  return created;
}

/** Workspace members (claimed, with a user id) at or above `min`, incl. a legacy owner. */
export async function membersAtLeast(db: ProducerDb, workspaceId: string, min: WorkspaceRole): Promise<string[]> {
  const [members, ws] = await Promise.all([
    db.workspaceMember.findMany({
      where: { workspaceId, userId: { not: null } },
      select: { userId: true, role: true },
      take: 1000,
    }),
    db.workspace.findUnique({ where: { id: workspaceId }, select: { ownerUserId: true } }),
  ]);
  const ranked = new Map<string, number>();
  for (const m of members) if (m.userId) ranked.set(m.userId, ROLE_RANK[m.role]);
  if (ws?.ownerUserId && !ranked.has(ws.ownerUserId)) ranked.set(ws.ownerUserId, ROLE_RANK.owner);
  return [...ranked.entries()]
    .filter(([, rank]) => rank >= ROLE_RANK[min])
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_RECIPIENTS)
    .map(([id]) => id);
}

/** True when the user id belongs to this workspace (member row or legacy owner). */
async function isMember(db: ProducerDb, workspaceId: string, userId: string): Promise<boolean> {
  const m = await db.workspaceMember.findFirst({ where: { workspaceId, userId }, select: { id: true } });
  if (m) return true;
  const ws = await db.workspace.findUnique({ where: { id: workspaceId }, select: { ownerUserId: true } });
  return ws?.ownerUserId === userId;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export interface ApprovalNeededInput {
  workspaceId: string;
  source: InboxSourceKey;
  sourceId: string;
  /** What is waiting, e.g. "Send follow-up to Ada". */
  title: string;
  /** Deep link; defaults to the unified inbox filtered to this queue. */
  href?: string;
  /** Requester (excluded: you don't need to approve your own request). */
  requestedBy?: string | null;
  /** Minimum role that can decide this queue (default editor). */
  decideRole?: WorkspaceRole;
}

/** "New approval needed" → every member who can decide it, except the requester. */
export async function notifyApprovalNeeded(input: ApprovalNeededInput, db: ProducerDb = defaultDb()): Promise<number> {
  // Phase 4a: approval.needed webhook (once per approval, never throws).
  await emitWebhookEvent({
    workspaceId: input.workspaceId,
    type: "approval.needed",
    data: {
      source: input.source,
      sourceId: input.sourceId,
      title: input.title,
      href: safeHref(input.href ?? `/dashboard/approvals?source=${input.source}`),
      requestedBy: input.requestedBy ?? null,
    },
    dedupKey: `approval.needed:${input.source}:${input.sourceId}`,
  });
  try {
    const requester = actorUserId(input.requestedBy);
    const recipients = (await membersAtLeast(db, input.workspaceId, input.decideRole ?? "editor")).filter(
      (id) => id !== requester,
    );
    const label = INBOX_SOURCE_LABELS[input.source];
    return await createAndEmit(
      db,
      recipients.map<NotificationInput>((userId) => ({
        workspaceId: input.workspaceId,
        userId,
        kind: "approval_needed",
        title: `${label} needs your approval`,
        body: input.title,
        href: input.href ?? `/dashboard/approvals?source=${input.source}`,
        sourceType: input.source,
        sourceId: input.sourceId,
        dedupKey: `approval_needed:${input.source}:${input.sourceId}`,
      })),
    );
  } catch (e) {
    warn("approval_needed", e);
    return 0;
  }
}

export interface ApprovalDecidedInput {
  workspaceId: string;
  source: InboxSourceKey;
  sourceId: string;
  title: string;
  decision: "approved" | "denied";
  decidedBy?: string | null;
  requestedBy?: string | null;
  href?: string;
}

/** "Approval decided" → the requester (when a member and not the decider). */
export async function notifyApprovalDecided(input: ApprovalDecidedInput, db: ProducerDb = defaultDb()): Promise<number> {
  // Phase 4a: approval.decided webhook — fires even when nobody is notified.
  await emitWebhookEvent({
    workspaceId: input.workspaceId,
    type: "approval.decided",
    data: {
      source: input.source,
      sourceId: input.sourceId,
      title: input.title,
      decision: input.decision,
      decidedBy: input.decidedBy ?? null,
    },
    dedupKey: `approval.decided:${input.source}:${input.sourceId}`,
  });
  try {
    const requester = actorUserId(input.requestedBy);
    if (!requester || requester === actorUserId(input.decidedBy)) return 0;
    if (!(await isMember(db, input.workspaceId, requester))) return 0;
    const label = INBOX_SOURCE_LABELS[input.source];
    return await createAndEmit(db, [
      {
        workspaceId: input.workspaceId,
        userId: requester,
        kind: "approval_decided",
        title: `${label} ${input.decision === "approved" ? "approved" : "denied"}`,
        body: input.title,
        href: input.href ?? "/dashboard/approvals",
        sourceType: input.source,
        sourceId: input.sourceId,
        dedupKey: `approval_decided:${input.source}:${input.sourceId}`,
      },
    ]);
  } catch (e) {
    warn("approval_decided", e);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Alerts, runs, invites
// ---------------------------------------------------------------------------

export interface AlertFiredInput {
  workspaceId: string;
  eventId: string;
  title: string;
  body?: string | null;
  /** The alert's dashboard link (absolute links fall back to the alerts page). */
  link?: string | null;
}

/** "Alert fired" (lib/alerts) → every member of the workspace. */
export async function notifyAlertFired(input: AlertFiredInput, db: ProducerDb = defaultDb()): Promise<number> {
  try {
    const recipients = await membersAtLeast(db, input.workspaceId, "viewer");
    const href = input.link && input.link.startsWith("/dashboard") ? input.link : "/dashboard/alerts";
    return await createAndEmit(
      db,
      recipients.map<NotificationInput>((userId) => ({
        workspaceId: input.workspaceId,
        userId,
        kind: "alert_fired",
        title: input.title,
        body: input.body ?? null,
        href,
        sourceType: "alert_event",
        sourceId: input.eventId,
        dedupKey: `alert:${input.eventId}`,
      })),
    );
  } catch (e) {
    warn("alert_fired", e);
    return 0;
  }
}

export interface AgentRunFailedInput {
  workspaceId: string;
  runId: string;
  kind?: string | null;
  startedBy?: string | null;
}

/** "Agent run failed" → whoever started it; editors+ when an agent/system started it. */
export async function notifyAgentRunFailed(input: AgentRunFailedInput, db: ProducerDb = defaultDb()): Promise<number> {
  try {
    const starter = actorUserId(input.startedBy);
    const recipients =
      starter && (await isMember(db, input.workspaceId, starter))
        ? [starter]
        : await membersAtLeast(db, input.workspaceId, "editor");
    const kind = input.kind ? `${input.kind.replace(/_/g, " ")} run` : "Agent run";
    return await createAndEmit(
      db,
      recipients.map<NotificationInput>((userId) => ({
        workspaceId: input.workspaceId,
        userId,
        kind: "run_failed",
        title: `${kind[0]!.toUpperCase()}${kind.slice(1)} failed`,
        body: "Open the run to see the timeline and the error.",
        href: `/dashboard/runs/${encodeURIComponent(input.runId)}`,
        sourceType: "agent_run",
        sourceId: input.runId,
        dedupKey: `run_failed:${input.runId}`,
      })),
    );
  } catch (e) {
    warn("run_failed", e);
    return 0;
  }
}

export interface InviteAcceptedInput {
  workspaceId: string;
  memberUserId: string;
  email?: string | null;
  role?: WorkspaceRole | string | null;
}

/** "Invite accepted" → the workspace's admins and owners (not the new member). */
export async function notifyInviteAccepted(input: InviteAcceptedInput, db: ProducerDb = defaultDb()): Promise<number> {
  try {
    const recipients = (await membersAtLeast(db, input.workspaceId, "admin")).filter((id) => id !== input.memberUserId);
    const who = input.email?.trim() || "A new member";
    return await createAndEmit(
      db,
      recipients.map<NotificationInput>((userId) => ({
        workspaceId: input.workspaceId,
        userId,
        kind: "invite_accepted",
        title: `${who} joined the workspace`,
        body: input.role ? `They joined as ${input.role}.` : null,
        href: "/dashboard/settings/members",
        sourceType: "workspace_member",
        sourceId: input.memberUserId,
        dedupKey: `invite_accepted:${input.workspaceId}:${input.memberUserId}`,
      })),
    );
  } catch (e) {
    warn("invite_accepted", e);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Phase 4b: Dataset Builder staleness
// ---------------------------------------------------------------------------

export interface DatasetStaleInput {
  workspaceId: string;
  datasetId: string;
  version: number;
  /** e.g. "Your pricing dataset is 120 days old". */
  title: string;
  body?: string | null;
}

/** "Dataset is stale" → editors and up (they can re-ingest and recompile). */
export async function notifyDatasetStale(input: DatasetStaleInput, db: ProducerDb = defaultDb()): Promise<number> {
  try {
    const recipients = await membersAtLeast(db, input.workspaceId, "editor");
    return await createAndEmit(
      db,
      recipients.map<NotificationInput>((userId) => ({
        workspaceId: input.workspaceId,
        userId,
        kind: "alert_fired",
        title: input.title,
        body: input.body ?? null,
        href: "/dashboard/datasets?tab=build",
        sourceType: "dataset",
        sourceId: input.datasetId,
        dedupKey: `dataset_stale:${input.datasetId}:v${input.version}`,
      })),
    );
  } catch (e) {
    warn("dataset_stale", e);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Phase 10 (ops-core): helpdesk SLA breach
// ---------------------------------------------------------------------------

export interface TicketSlaBreachedInput {
  workspaceId: string;
  ticketId: string;
  number: number;
  subject: string;
  kind: "first_response" | "resolution";
  assigneeId?: string | null;
}

/** "Ticket #12 missed its first-response target" → the assignee (if a member) + editors. */
export async function notifyTicketSlaBreached(input: TicketSlaBreachedInput, db: ProducerDb = defaultDb()): Promise<number> {
  try {
    const editors = await membersAtLeast(db, input.workspaceId, "editor");
    const assignee = input.assigneeId && (await isMember(db, input.workspaceId, input.assigneeId)) ? [input.assigneeId] : [];
    const recipients = [...new Set([...assignee, ...editors])];
    const what = input.kind === "first_response" ? "first-response" : "resolution";
    return await createAndEmit(
      db,
      recipients.map<NotificationInput>((userId) => ({
        workspaceId: input.workspaceId,
        userId,
        kind: "alert_fired",
        title: `Ticket #${input.number} missed its ${what} target`,
        body: input.subject.slice(0, 200),
        href: `/dashboard/ops/helpdesk?ticket=${encodeURIComponent(input.ticketId)}`,
        sourceType: "ops_ticket",
        sourceId: input.ticketId,
        dedupKey: `ticket_sla:${input.ticketId}:${input.kind}`,
      })),
    );
  } catch (e) {
    warn("ticket_sla_breached", e);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Phase 13 (twincore): digital twin alerts (dock overdue, bin low, machine
// stopped while late, register left open) → editors, once per condition.
// ---------------------------------------------------------------------------

export interface TwinAlertInput {
  workspaceId: string;
  siteId: string;
  siteName: string;
  objectId: string;
  objectLabel: string;
  message: string;
  /** Names the condition's record (lib/twin/derive.ts alertCandidates) — one notification per recipient per condition. */
  dedupKey: string;
}

/** "Dock 3: TRK-1 is 45 min past its ETA" → editors, linking to the object on the twin. */
export async function notifyTwinAlert(input: TwinAlertInput, db: ProducerDb = defaultDb()): Promise<number> {
  try {
    const editors = await membersAtLeast(db, input.workspaceId, "editor");
    return await createAndEmit(
      db,
      editors.map<NotificationInput>((userId) => ({
        workspaceId: input.workspaceId,
        userId,
        kind: "alert_fired",
        title: `${input.siteName} · ${input.objectLabel}`,
        body: input.message.slice(0, 500),
        href: `/dashboard/ops/twin/${encodeURIComponent(input.siteId)}?object=${encodeURIComponent(input.objectId)}`,
        sourceType: "twin_object",
        sourceId: input.objectId,
        dedupKey: input.dedupKey,
      })),
    );
  } catch (e) {
    warn("twin_alert", e);
    return 0;
  }
}
