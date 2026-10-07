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
// Phase 18.1 (WS=find): per-person notification channels.
import { filterByNotificationPrefs } from "@/lib/preferences";
// Phase 18.3 (WS=trust): delivery to phone push (Expo, lib/push/notify.ts),
// Web Push and Slack, per the person's channel matrix.
import { deliverNow } from "./deliver";

export type ProducerDb = Pick<Prisma.TransactionClient, "notification" | "workspaceMember" | "workspace">;

// Same ranks as lib/authz ROLE_RANK — kept local so lib/authz can import the
// producers statically without an import cycle.
const ROLE_RANK: Record<WorkspaceRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

/** Upper bound on fan-out per event (large workspaces get the most senior first). */
const MAX_RECIPIENTS = 100;

function defaultDb(): ProducerDb {
  return prisma as unknown as ProducerDb;
}

/** Phase 18.1: recipients in focus right now (best-effort: on error nobody is held). */
async function recipientsInFocus(inputs: NotificationInput[]): Promise<Set<string>> {
  try {
    const { usersInFocus } = await import("@/lib/desktop/focus.server");
    return await usersInFocus(inputs.map((n) => n.userId));
  } catch {
    return new Set();
  }
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
async function createAndEmit(db: ProducerDb, all: NotificationInput[]): Promise<number> {
  // Phase 18.1 integration — the order is deliberate:
  // 1. (WS=find) each person's notification channels (lib/preferences —
  //    Settings → You → Notifications). A kind muted or the bell switched
  //    off → no row at all (focus never resurrects a muted kind).
  const inputs = await filterByNotificationPrefs(all, "inApp");
  // 2. (WS=desk) a recipient in focus / do not disturb gets the row queued
  //    (held_at) and no push now — lib/desktop/focus.server.ts releases the
  //    row and sends its push (through the same push filter) when focus ends.
  const held = await recipientsInFocus(inputs);
  const created = await createNotifications(db, inputs, { heldUserIds: held });
  if (created > 0) {
    // 3. deliver only rows that are not held, to the channels each person
    //    allows for the kind (only new rows deliver, which is also what keeps
    //    a re-fired event from pushing twice). Phase 18.3 (WS=trust): phone
    //    push, Web Push and Slack through lib/notifications/deliver.ts.
    const now = held.size ? inputs.filter((n) => !held.has(n.userId)) : inputs;
    await deliverNow(now).catch((e: unknown) => warn("deliver", e));
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

export interface CacheShareLowInput {
  workspaceId: string;
  /** The last 24 h's cache-read share, 0..1. */
  share: number;
  calls: number;
  /** UTC day (YYYY-MM-DD): one notification per recipient per day. */
  day: string;
}

/**
 * Phase 17 (observability): the prompt cache stopped paying — the last 24 h
 * read less than 60% of input tokens from it. → the workspace's admins (the
 * people who see Settings → Usage), once per day.
 */
export async function notifyCacheShareLow(input: CacheShareLowInput, db: ProducerDb = defaultDb()): Promise<number> {
  try {
    const admins = await membersAtLeast(db, input.workspaceId, "admin");
    const pct = Math.round(input.share * 100);
    return await createAndEmit(
      db,
      admins.map<NotificationInput>((userId) => ({
        workspaceId: input.workspaceId,
        userId,
        kind: "alert_fired",
        title: `Model cache reads fell to ${pct}%`,
        body: `In the last 24 hours only ${pct}% of model input was read from the prompt cache (${input.calls} calls; below 60% means something keeps changing the cached prefix). AI cost per message is higher until it recovers.`,
        href: "/dashboard/settings/usage#ai-cost-speed",
        sourceType: "usage",
        sourceId: `cache_share:${input.day}`,
        dedupKey: `cache_share_low:${input.workspaceId}:${input.day}`,
      })),
    );
  } catch (e) {
    warn("cache_share_low", e);
    return 0;
  }
}

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

// ---------------------------------------------------------------------------
// Phase 18.2 (WS=comms): Messages and Reminders. Same producer seam as every
// other kind, so the member's channel preferences filter them (a muted kind
// writes nothing) and focus / do not disturb holds them until focus ends.
// ---------------------------------------------------------------------------

export interface ReminderDueInput {
  workspaceId: string;
  userId: string;
  reminderId: string;
  title: string;
  /** The occurrence's due time (one notification per occurrence). */
  dueAt: Date;
}

/** "Call the bank" is due → the reminder's owner, once per occurrence. */
export async function notifyReminderDue(input: ReminderDueInput, db: ProducerDb = defaultDb()): Promise<number> {
  try {
    if (!(await isMember(db, input.workspaceId, input.userId))) return 0;
    return await createAndEmit(db, [
      {
        workspaceId: input.workspaceId,
        userId: input.userId,
        kind: "reminder_due",
        title: input.title.slice(0, 200),
        body: null,
        href: `/dashboard/reminders?reminder=${encodeURIComponent(input.reminderId)}`,
        sourceType: "reminder",
        sourceId: input.reminderId,
        dedupKey: `reminder_due:${input.reminderId}:${input.dueAt.toISOString()}`,
      },
    ]);
  } catch (e) {
    warn("reminder_due", e);
    return 0;
  }
}

export interface ChannelMessageNoticeInput {
  workspaceId: string;
  channelId: string;
  messageId: string;
  /** Recipients (members of the channel; the author is never notified). */
  userIds: readonly string[];
  authorUserId: string | null;
  authorName: string;
  /** "#launch" or the DM's name — shown in the title. */
  channelName: string;
  /** The message text (trimmed to a preview). */
  body: string;
  /** Deep link to the message in the Messages app. */
  href: string;
}

function preview(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

/** "@Ana" in a channel → Ana (a member of the workspace), once per message. */
export async function notifyMention(input: ChannelMessageNoticeInput, db: ProducerDb = defaultDb()): Promise<number> {
  try {
    const recipients: string[] = [];
    for (const u of new Set(input.userIds)) {
      if (u && u !== input.authorUserId && (await isMember(db, input.workspaceId, u))) recipients.push(u);
    }
    return await createAndEmit(
      db,
      recipients.map<NotificationInput>((userId) => ({
        workspaceId: input.workspaceId,
        userId,
        kind: "mention",
        title: `${input.authorName} mentioned you in ${input.channelName}`.slice(0, 200),
        body: preview(input.body),
        href: input.href,
        sourceType: "team_chat_message",
        sourceId: input.messageId,
        dedupKey: `mention:${input.messageId}`,
      })),
    );
  } catch (e) {
    warn("mention", e);
    return 0;
  }
}

/** A direct message → the other people in the DM, once per message. */
export async function notifyDirectMessage(input: ChannelMessageNoticeInput, db: ProducerDb = defaultDb()): Promise<number> {
  try {
    const recipients: string[] = [];
    for (const u of new Set(input.userIds)) {
      if (u && u !== input.authorUserId && (await isMember(db, input.workspaceId, u))) recipients.push(u);
    }
    return await createAndEmit(
      db,
      recipients.map<NotificationInput>((userId) => ({
        workspaceId: input.workspaceId,
        userId,
        kind: "direct_message",
        title: `${input.authorName} sent you a message`.slice(0, 200),
        body: preview(input.body),
        href: input.href,
        sourceType: "team_chat_message",
        sourceId: input.messageId,
        dedupKey: `direct_message:${input.messageId}`,
      })),
    );
  } catch (e) {
    warn("direct_message", e);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Phase 18.3 (WS=trust): Notifications 2.0 — run finished, invoice paid,
// ticket assigned, meeting starting. Same seam as every other kind: the
// person's channels filter them (a muted kind writes nothing), focus holds
// them, and each is idempotent through its dedup key.
// ---------------------------------------------------------------------------

const NON_PERSON_STARTERS = new Set(["scheduler", "cron", "workflow", "autopilot", "worker", "ai", "lead"]);

/** Chat turns shorter than this don't announce that they finished (the person is watching). */
export const RUN_FINISHED_MIN_CHAT_MS = 2 * 60_000;

export interface RunFinishedInput {
  workspaceId: string;
  runId: string;
  kind?: string | null;
  startedBy?: string | null;
  /** Delegated sub-agent runs report through their parent: no notification. */
  parentRunId?: string | null;
  createdAt?: Date | null;
  endedAt?: Date | null;
  /**
   * Phase 19A integration: the run's spend cap (AgentRun.budgetMicroUsd).
   * A cursor run with one is agent mode ("do it in the background, max $3");
   * without one it is a spoken conversation the person heard live.
   */
  budgetMicroUsd?: number | null;
}

/** Should this finished run notify? Top-level runs a person started; quick chat turns don't. PURE. */
export function runFinishedWorthNotifying(input: RunFinishedInput): boolean {
  if (input.parentRunId) return false;
  const starter = actorUserId(input.startedBy);
  // Runs the system started (scheduled skills, workflows, autopilot) are not a person's.
  if (!starter || NON_PERSON_STARTERS.has(starter.toLowerCase()) || starter.startsWith("agent")) return false;
  if (input.kind === "chat") {
    const ms = input.createdAt && input.endedAt ? input.endedAt.getTime() - input.createdAt.getTime() : 0;
    return ms >= RUN_FINISHED_MIN_CHAT_MS;
  }
  // Phase 19A integration: a cursor conversation answers out loud while the
  // person listens (like a quick chat turn); its agent-mode runs (a spend cap,
  // background work) announce that they finished.
  if (input.kind === "cursor") return input.budgetMicroUsd != null;
  return true;
}

/** "Mission run finished" → the member who started it (once per run). */
export async function notifyRunFinished(input: RunFinishedInput, db: ProducerDb = defaultDb()): Promise<number> {
  try {
    if (!runFinishedWorthNotifying(input)) return 0;
    const starter = actorUserId(input.startedBy)!;
    if (!(await isMember(db, input.workspaceId, starter))) return 0;
    const kind = input.kind && input.kind !== "chat" ? `${input.kind.replace(/_/g, " ")} run` : "Agent task";
    return await createAndEmit(db, [
      {
        workspaceId: input.workspaceId,
        userId: starter,
        kind: "run_finished",
        title: `${kind[0]!.toUpperCase()}${kind.slice(1)} finished`,
        body: "Open the run to see what it did.",
        href: `/dashboard/runs/${encodeURIComponent(input.runId)}`,
        sourceType: "agent_run",
        sourceId: input.runId,
        dedupKey: `run_finished:${input.runId}`,
      },
    ]);
  } catch (e) {
    warn("run_finished", e);
    return 0;
  }
}

export interface InvoicePaidInput {
  workspaceId: string;
  invoiceId: string;
  number?: string | null;
  totalCents?: number | null;
  currency?: string | null;
}

/** "Invoice INV-0042 was paid in full" → the workspace's admins and owners (once per invoice). */
export async function notifyInvoicePaid(input: InvoicePaidInput, db: ProducerDb = defaultDb()): Promise<number> {
  try {
    const recipients = await membersAtLeast(db, input.workspaceId, "admin");
    const label = input.number ? `Invoice ${input.number}` : "An invoice";
    const amount =
      typeof input.totalCents === "number"
        ? new Intl.NumberFormat("en-US", { style: "currency", currency: input.currency || "USD" }).format(input.totalCents / 100)
        : null;
    return await createAndEmit(
      db,
      recipients.map<NotificationInput>((userId) => ({
        workspaceId: input.workspaceId,
        userId,
        kind: "invoice_paid",
        title: `${label} was paid in full`,
        body: amount ? `${amount} received.` : null,
        href: `/dashboard/ops/invoices?id=${encodeURIComponent(input.invoiceId)}`,
        sourceType: "ops_invoice",
        sourceId: input.invoiceId,
        dedupKey: `invoice_paid:${input.invoiceId}`,
      })),
    );
  } catch (e) {
    warn("invoice_paid", e);
    return 0;
  }
}

export interface TicketAssignedInput {
  workspaceId: string;
  ticketId: string;
  number: number;
  subject: string;
  assigneeId: string;
  /** Who assigned it (not notified when they assigned themselves). */
  assignedBy?: string | null;
  /** The assignment's moment (one notification per assignment). */
  at: Date;
}

/** "Ticket #12 was assigned to you" → the assignee (a member, not the person who assigned it to themselves). */
export async function notifyTicketAssigned(input: TicketAssignedInput, db: ProducerDb = defaultDb()): Promise<number> {
  try {
    if (!input.assigneeId || input.assigneeId === actorUserId(input.assignedBy)) return 0;
    if (!(await isMember(db, input.workspaceId, input.assigneeId))) return 0;
    return await createAndEmit(db, [
      {
        workspaceId: input.workspaceId,
        userId: input.assigneeId,
        kind: "ticket_assigned",
        title: `Ticket #${input.number} was assigned to you`,
        body: input.subject.slice(0, 200),
        href: `/dashboard/ops/helpdesk?ticket=${encodeURIComponent(input.ticketId)}`,
        sourceType: "ops_ticket",
        sourceId: input.ticketId,
        dedupKey: `ticket_assigned:${input.ticketId}:${input.assigneeId}:${input.at.toISOString()}`,
      },
    ]);
  } catch (e) {
    warn("ticket_assigned", e);
    return 0;
  }
}

export interface MeetingStartingInput {
  workspaceId: string;
  userId: string;
  /** Source-prefixed event id ("booking:…", "google:…", "ops_event:…"). */
  eventId: string;
  title: string;
  startsAt: Date;
  href?: string | null;
}

/** "Sales call starts at 10:30" → one person, once per event occurrence. */
export async function notifyMeetingStarting(input: MeetingStartingInput, db: ProducerDb = defaultDb()): Promise<number> {
  try {
    if (!(await isMember(db, input.workspaceId, input.userId))) return 0;
    const mins = Math.max(0, Math.round((input.startsAt.getTime() - Date.now()) / 60_000));
    return await createAndEmit(db, [
      {
        workspaceId: input.workspaceId,
        userId: input.userId,
        kind: "meeting_starting",
        title: `${input.title.slice(0, 160)} starts ${mins <= 1 ? "now" : `in ${mins} minutes`}`,
        body: null,
        href: input.href && input.href.startsWith("/dashboard") ? input.href : "/dashboard/calendar",
        sourceType: "calendar_event",
        sourceId: input.eventId.slice(0, 128),
        dedupKey: `meeting_starting:${input.eventId}:${input.startsAt.toISOString()}`.slice(0, 200),
      },
    ]);
  } catch (e) {
    warn("meeting_starting", e);
    return 0;
  }
}
