// Marketr — Connector Agent slice 6: Boardy escalation rail.
// SPEC-CONNECTOR-AGENT.md §4/§5/§6.
//
// boardy.ai/agentskill is an INSTRUCTION PAGE for an email flow — not a
// programmatic API or MCP (verified live 2026-09-30). So there is nothing to
// integrate against programmatically. The rail is:
//
//   Connector drafts the Boardy request email (context-rich: who the target
//   is, why, what the tenant offers) → the tenant approves PER INSTANCE
//   (human-only, in the approval inbox pattern from slice 4) → it sends
//   from the tenant's OWN address to boardy@boardy.ai → Boardy's reply is
//   triaged as a PRIORITY thread.
//
// Boardy is FREE to use (Tico 2026-09-30) — no commercial terms.
//
// The native loop NEVER blocks on this rail: escalation is optional and
// async. Nothing in the native intro path imports this module; every rail
// method is a separate, tenant-scoped entry point that throws cleanly.

import type { PrismaClient } from "@prisma/client";
import { ConnectorError } from "./types";
import { type IntroActor, requireHumanActor } from "./introductions";
import {
  isConnectorMode,
  validateConnectorMode,
  type ConnectorMode,
} from "./modes";
import { notifyApprovalNeeded } from "@/lib/notifications/producers";

/** Boardy is reached by email — the rail's destination, per the agentskill. */
export const BOARDY_EMAIL = "boardy@boardy.ai";

/** Alias kept beside BOARDY_EMAIL for readers of the rail docs. */
export const BOARDY_REQUEST_EMAIL = BOARDY_EMAIL;

// ---------------------------------------------------------------------------
// Status + transition law (pure).
// ---------------------------------------------------------------------------

export const BOARDY_REQUEST_STATUSES = [
  "draft",
  "approved",
  "declined",
  "sent",
  "replied",
  "cancelled",
] as const;
export type BoardyRequestStatus = (typeof BOARDY_REQUEST_STATUSES)[number];

function isBoardyRequestStatus(v: unknown): v is BoardyRequestStatus {
  return (
    typeof v === "string" &&
    (BOARDY_REQUEST_STATUSES as readonly string[]).includes(v)
  );
}

const BOARDY_TRANSITIONS: Record<
  BoardyRequestStatus,
  Array<{ action: string; to: BoardyRequestStatus }>
> = {
  // draft: auto-drafted only — NOTHING sends from here. The tenant approves
  // per instance (the money rule of this rail).
  draft: [
    { action: "tenant_approve", to: "approved" },
    { action: "tenant_decline", to: "declined" },
    { action: "cancel", to: "cancelled" },
  ],
  approved: [
    { action: "send", to: "sent" },
    { action: "cancel", to: "cancelled" },
  ],
  declined: [],
  sent: [{ action: "reply_received", to: "replied" }],
  replied: [],
  cancelled: [],
};

/** Pure transition check: illegal transitions throw illegal_boardy_transition. */
export function assertBoardyTransition(
  from: string,
  action: string,
): BoardyRequestStatus {
  if (!isBoardyRequestStatus(from)) {
    throw new ConnectorError(
      "illegal_boardy_transition",
      `Cannot ${action} a Boardy request with unknown status "${from}".`,
    );
  }
  const legal = BOARDY_TRANSITIONS[from] ?? [];
  const hit = legal.find((t) => t.action === action);
  if (!hit) {
    throw new ConnectorError(
      "illegal_boardy_transition",
      `Cannot ${action} a Boardy request in status "${from}".`,
    );
  }
  return hit.to;
}

// ---------------------------------------------------------------------------
// Input validation (pure).
// ---------------------------------------------------------------------------

export interface BoardyRequestInput {
  targetName?: unknown;
  targetRole?: unknown;
  targetContext?: unknown;
  offerSummary?: unknown;
  mode?: unknown;
  tenantName?: unknown;
  /** Optional hand-crafted copy; when absent the rail builds it from fields. */
  draftedSubject?: unknown;
  draftedBody?: unknown;
}

export interface ValidBoardyRequestInput {
  targetName: string;
  targetRole: string | null;
  targetContext: string;
  offerSummary: string;
  mode: ConnectorMode;
  tenantName: string;
  draftedSubject: string;
  draftedBody: string;
}

const MIN_CONTEXT_LEN = 20;

function requiredText(
  value: unknown,
  field: string,
  errors: string[],
  min = 1,
): string | null {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) {
    errors.push(`${field} is required.`);
    return null;
  }
  if (v.length < min) {
    errors.push(`${field} must be at least ${min} characters — the request is context-rich by design.`);
    return null;
  }
  return v;
}

export function validateBoardyRequestInput(input: BoardyRequestInput): {
  errors: string[];
  value: ValidBoardyRequestInput | null;
} {
  const errors: string[] = [];
  const targetName = requiredText(input.targetName, "targetName", errors);
  const targetRole =
    input.targetRole == null
      ? null
      : typeof input.targetRole === "string" && input.targetRole.trim()
        ? input.targetRole.trim()
        : null;
  if (input.targetRole != null && typeof input.targetRole !== "string") {
    errors.push("targetRole must be a string.");
  }
  const targetContext = requiredText(input.targetContext, "targetContext", errors, MIN_CONTEXT_LEN);
  const offerSummary = requiredText(input.offerSummary, "offerSummary", errors, MIN_CONTEXT_LEN);
  const tenantName = requiredText(input.tenantName, "tenantName", errors);

  const { errors: modeErrors, value: mode } = validateConnectorMode(input.mode);
  errors.push(...modeErrors);

  const draftedSubject =
    input.draftedSubject == null
      ? null
      : typeof input.draftedSubject === "string" && input.draftedSubject.trim()
        ? input.draftedSubject.trim()
        : null;
  if (input.draftedSubject != null && typeof input.draftedSubject !== "string") {
    errors.push("draftedSubject must be a string.");
  }
  const draftedBody =
    input.draftedBody == null
      ? null
      : typeof input.draftedBody === "string" && input.draftedBody.trim()
        ? input.draftedBody.trim()
        : null;
  if (input.draftedBody != null && typeof input.draftedBody !== "string") {
    errors.push("draftedBody must be a string.");
  }
  if (errors.length > 0) return { errors, value: null };

  // Copy: hand-crafted when supplied, otherwise built from the fields.
  const draft =
    draftedSubject && draftedBody
      ? { subject: draftedSubject, body: draftedBody }
      : buildBoardyRequestEmail({
          tenantName: tenantName as string,
          targetName: targetName as string,
          targetRole,
          targetContext: targetContext as string,
          offerSummary: offerSummary as string,
          mode: (mode ?? "leads") as ConnectorMode,
        });

  return {
    errors,
    value: {
      targetName: targetName as string,
      targetRole,
      targetContext: targetContext as string,
      offerSummary: offerSummary as string,
      mode: (mode ?? "leads") as ConnectorMode,
      tenantName: tenantName as string,
      draftedSubject: draft.subject,
      draftedBody: draft.body,
    },
  };
}

// ---------------------------------------------------------------------------
// The email draft (pure — the copy shape is pinned by tests).
// ---------------------------------------------------------------------------

export interface BoardyEmailDraftInput {
  tenantName: string;
  targetName: string;
  targetRole?: string | null;
  targetContext: string;
  offerSummary: string;
  mode: ConnectorMode;
}

/**
 * Context-rich Boardy request email. WHO the target is, WHY the intro is
 * wanted, WHAT the tenant offers them. Ends with Boardy's double-opt-in
 * norms restated — no embarrassment either way.
 */
export function buildBoardyRequestEmail(input: BoardyEmailDraftInput): {
  subject: string;
  body: string;
} {
  const subject = `Intro request: ${input.tenantName} → ${input.targetName}`;
  const who = input.targetRole
    ? `${input.targetName} — ${input.targetRole}`
    : input.targetName;
  const contextLine =
    input.mode === "funding"
      ? "This is for my raise — an investor intro via my funding workflow."
      : "This is for leads — a customer/partner intro.";
  const body = [
    "Hi Boardy,",
    "",
    `I'm ${input.tenantName} and I'd love your help with a warm intro.`,
    "",
    `WHO: ${who}`,
    "",
    `WHY NOW: ${input.targetContext}`,
    "",
    `WHAT I BRING THEM: ${input.offerSummary}`,
    "",
    `CONTEXT: ${contextLine}`,
    "",
    `I know your double-opt-in norms apply on your side — please ask ${input.targetName} before anything comes back to me. A "no" is completely fine; no embarrassment either way.`,
    "",
    "Thanks,",
    input.tenantName,
  ].join("\n");
  return { subject, body };
}

// ---------------------------------------------------------------------------
// View types.
// ---------------------------------------------------------------------------

export interface BoardyRequestEventView {
  id: string;
  kind: string;
  actorKind: string;
  actorIdentity: string;
  message: string | null;
  createdAt: Date;
}

export interface BoardyRequestView {
  id: string;
  status: BoardyRequestStatus;
  targetName: string;
  targetRole: string | null;
  targetContext: string;
  offerSummary: string;
  draftedSubject: string;
  draftedBody: string;
  mode: ConnectorMode;
  approvedBy: string | null;
  approvedAt: Date | null;
  sentVia: string | null;
  sentAt: Date | null;
  priorityThread: boolean;
  replySummary: string | null;
  repliedAt: Date | null;
  events: BoardyRequestEventView[];
  createdAt: Date;
  updatedAt: Date;
}

type BoardyRequestRow = {
  id: string;
  status: string;
  targetName: string;
  targetRole: string | null;
  targetContext: string;
  offerSummary: string;
  draftedSubject: string;
  draftedBody: string;
  mode: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  sentVia: string | null;
  sentAt: Date | null;
  priorityThread: boolean;
  replySummary: string | null;
  repliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type BoardyRequestEventRow = {
  id: string;
  kind: string;
  actorKind: string;
  actorIdentity: string;
  message: string | null;
  createdAt: Date;
};

function toBoardyRequestView(
  row: BoardyRequestRow,
  events: BoardyRequestEventRow[],
): BoardyRequestView {
  const status = isBoardyRequestStatus(row.status) ? row.status : "draft";
  const mode = isConnectorMode(row.mode) ? row.mode : "leads";
  return {
    id: row.id,
    status,
    targetName: row.targetName,
    targetRole: row.targetRole,
    targetContext: row.targetContext,
    offerSummary: row.offerSummary,
    draftedSubject: row.draftedSubject,
    draftedBody: row.draftedBody,
    mode,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    sentVia: row.sentVia,
    sentAt: row.sentAt,
    priorityThread: row.priorityThread,
    replySummary: row.replySummary,
    repliedAt: row.repliedAt,
    events: events.map((e) => ({
      id: e.id,
      kind: e.kind,
      actorKind: e.actorKind,
      actorIdentity: e.actorIdentity,
      message: e.message,
      createdAt: e.createdAt,
    })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Store — every method takes workspaceId first and every query is scoped to
// it. A row id from another tenant passed with this tenant's workspaceId
// throws not_found — never a cross-tenant read.
// ---------------------------------------------------------------------------

const BOARDY_INCLUDES = {
  events: { orderBy: { createdAt: "asc" } as const },
} as const;

export class PrismaBoardyRailStore {
  constructor(private prisma: PrismaClient) {}

  private async getRequestOrThrow(
    workspaceId: string,
    requestId: string,
  ): Promise<{ row: BoardyRequestRow; events: BoardyRequestEventRow[] }> {
    const row = (await this.prisma.connectorBoardyRequest.findFirst({
      where: { id: requestId, workspaceId },
      include: BOARDY_INCLUDES,
    })) as (BoardyRequestRow & { events: BoardyRequestEventRow[] }) | null;
    if (!row) {
      throw new ConnectorError(
        "boardy_request_not_found",
        "Boardy request not found in this workspace.",
      );
    }
    const { events, ...rest } = row;
    return { row: rest as BoardyRequestRow, events };
  }

  private async listEvents(requestId: string): Promise<BoardyRequestEventRow[]> {
    return (await this.prisma.connectorBoardyRequestEvent.findMany({
      where: { requestId },
      orderBy: { createdAt: "asc" },
    })) as BoardyRequestEventRow[];
  }

  private async recordEvent(
    requestId: string,
    kind: string,
    actor: IntroActor,
    message?: string,
  ): Promise<void> {
    const actorKind = actor.kind;
    const actorIdentity =
      actor.kind === "human"
        ? actor.identity.trim() || "tenant"
        : (actor.identity ?? "connector-agent").trim() || "connector-agent";
    await this.prisma.connectorBoardyRequestEvent.create({
      data: {
        requestId,
        kind,
        actorKind,
        actorIdentity,
        message: message ?? null,
      },
    });
  }

  // ------------------------------------------------------------------
  // Draft — auto-draft only; NOTHING sends from here. The tenant approves
  // per instance. The draft is cheap and async: it never blocks the native
  // loop — the native intro path does not call into this store.
  // ------------------------------------------------------------------

  async draftBoardyRequest(
    workspaceId: string,
    input: BoardyRequestInput,
    opts: { draftedBy: IntroActor },
  ): Promise<BoardyRequestView> {
    const { errors, value } = validateBoardyRequestInput(input);
    if (!value) {
      throw new ConnectorError("invalid_boardy_request", errors.join(" "));
    }
    const row = (await this.prisma.connectorBoardyRequest.create({
      data: {
        workspaceId,
        status: "draft",
        targetName: value.targetName,
        targetRole: value.targetRole,
        targetContext: value.targetContext,
        offerSummary: value.offerSummary,
        draftedSubject: value.draftedSubject,
        draftedBody: value.draftedBody,
        mode: value.mode,
      },
      include: BOARDY_INCLUDES,
    })) as BoardyRequestRow & { events: BoardyRequestEventRow[] };
    await this.recordEvent(
      row.id,
      "boardy_request_drafted",
      opts.draftedBy,
      `Boardy escalation drafted for ${value.targetName}. Awaiting tenant approval — nothing sent.`,
    );
    // Phase 3 (J): best-effort "needs you" notification (never throws).
    await notifyApprovalNeeded({
      workspaceId,
      source: "boardy",
      sourceId: row.id,
      title: value.draftedSubject || `Request an intro to ${value.targetName}`,
      href: "/dashboard/connector",
      requestedBy: opts.draftedBy.identity,
    });
    return toBoardyRequestView(row, await this.listEvents(row.id));
  }

  async getBoardyRequest(
    workspaceId: string,
    requestId: string,
  ): Promise<BoardyRequestView> {
    const { row, events } = await this.getRequestOrThrow(workspaceId, requestId);
    return toBoardyRequestView(row, events);
  }

  async listBoardyRequests(workspaceId: string): Promise<BoardyRequestView[]> {
    const rows = (await this.prisma.connectorBoardyRequest.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      include: BOARDY_INCLUDES,
    })) as Array<BoardyRequestRow & { events: BoardyRequestEventRow[] }>;
    return rows.map((r) => {
      const { events, ...rest } = r;
      return toBoardyRequestView(rest as BoardyRequestRow, events);
    });
  }

  // ------------------------------------------------------------------
  // Approve — HUMAN ONLY. Per-instance approval, in the slice-4 inbox
  // pattern. The agent cannot approve on the tenant's behalf.
  // ------------------------------------------------------------------

  async approveBoardyRequest(
    workspaceId: string,
    requestId: string,
    opts: { actor: IntroActor },
  ): Promise<BoardyRequestView> {
    const { row } = await this.getRequestOrThrow(workspaceId, requestId);
    assertBoardyTransition(row.status, "tenant_approve");
    const approvedBy = requireHumanActor(opts.actor, "boardy_approve");
    const updated = (await this.prisma.connectorBoardyRequest.update({
      where: { id: requestId },
      data: {
        status: "approved",
        approvedBy,
        approvedAt: new Date(),
      },
      include: BOARDY_INCLUDES,
    })) as BoardyRequestRow & { events: BoardyRequestEventRow[] };
    await this.recordEvent(
      requestId,
      "boardy_request_approved",
      { kind: "human", identity: approvedBy },
      `Tenant approved the Boardy request draft for ${row.targetName}. Ready to send.`,
    );
    return toBoardyRequestView(updated, await this.listEvents(requestId));
  }

  // ------------------------------------------------------------------
  // Decline — HUMAN ONLY.
  // ------------------------------------------------------------------

  async declineBoardyRequest(
    workspaceId: string,
    requestId: string,
    opts: { actor: IntroActor; reason?: string },
  ): Promise<BoardyRequestView> {
    const { row } = await this.getRequestOrThrow(workspaceId, requestId);
    assertBoardyTransition(row.status, "tenant_decline");
    const declinedBy = requireHumanActor(opts.actor, "boardy_decline");
    const updated = (await this.prisma.connectorBoardyRequest.update({
      where: { id: requestId },
      data: { status: "declined" },
      include: BOARDY_INCLUDES,
    })) as BoardyRequestRow & { events: BoardyRequestEventRow[] };
    await this.recordEvent(
      requestId,
      "boardy_request_declined",
      { kind: "human", identity: declinedBy },
      opts.reason ? `Tenant declined: ${opts.reason}` : "Tenant declined the Boardy request.",
    );
    return toBoardyRequestView(updated, await this.listEvents(requestId));
  }

  // ------------------------------------------------------------------
  // Send — the approval gate. NO send without tenant approval: the status
  // must be "approved", else not_approved. Sends from the tenant's OWN
  // address via their connected account (sentVia), to boardy@boardy.ai.
  // Recorded as lineage — same pattern as the slice-4 ask sends.
  // ------------------------------------------------------------------

  async sendBoardyRequest(
    workspaceId: string,
    requestId: string,
    opts: { actor: IntroActor; sentVia: string },
  ): Promise<BoardyRequestView> {
    const { row } = await this.getRequestOrThrow(workspaceId, requestId);
    const sentBy = requireHumanActor(opts.actor, "boardy_send");
    const sentVia = opts.sentVia.trim();
    if (!sentVia) {
      throw new ConnectorError(
        "invalid_send_channel",
        "sentVia is required — the request sends from the tenant's own address via their connected messaging account.",
      );
    }
    if (row.status !== "approved") {
      throw new ConnectorError(
        "not_approved",
        "No send without tenant approval: this Boardy request has not been approved.",
      );
    }
    assertBoardyTransition(row.status, "send");
    const updated = (await this.prisma.connectorBoardyRequest.update({
      where: { id: requestId },
      data: { status: "sent", sentVia, sentAt: new Date() },
      include: BOARDY_INCLUDES,
    })) as BoardyRequestRow & { events: BoardyRequestEventRow[] };
    await this.recordEvent(
      requestId,
      "boardy_request_sent",
      { kind: "human", identity: sentBy },
      `Boardy request sent from the tenant's own address via ${sentVia} to ${BOARDY_EMAIL}. Subject: "${row.draftedSubject}"`,
    );
    return toBoardyRequestView(updated, await this.listEvents(requestId));
  }

  // ------------------------------------------------------------------
  // Cancel — draft or approved only.
  // ------------------------------------------------------------------

  async cancelBoardyRequest(
    workspaceId: string,
    requestId: string,
    opts: { actor: IntroActor; reason?: string },
  ): Promise<BoardyRequestView> {
    const { row } = await this.getRequestOrThrow(workspaceId, requestId);
    assertBoardyTransition(row.status, "cancel");
    const cancelledBy = requireHumanActor(opts.actor, "boardy_cancel");
    const updated = (await this.prisma.connectorBoardyRequest.update({
      where: { id: requestId },
      data: { status: "cancelled" },
      include: BOARDY_INCLUDES,
    })) as BoardyRequestRow & { events: BoardyRequestEventRow[] };
    await this.recordEvent(
      requestId,
      "boardy_request_cancelled",
      { kind: "human", identity: cancelledBy },
      opts.reason ? `Cancelled: ${opts.reason}` : "Boardy request cancelled.",
    );
    return toBoardyRequestView(updated, await this.listEvents(requestId));
  }

  // ------------------------------------------------------------------
  // Reply triage — Boardy's reply arrives (the tenant pastes/logs it, or
  // the mail connector flags it). Legal only from sent. The thread is
  // flagged as a PRIORITY thread for priority handling.
  // ------------------------------------------------------------------

  async markBoardyRequestReplied(
    workspaceId: string,
    requestId: string,
    opts: { summary?: string; triagedBy: string },
  ): Promise<BoardyRequestView> {
    const { row } = await this.getRequestOrThrow(workspaceId, requestId);
    assertBoardyTransition(row.status, "reply_received");
    const triagedBy = requireHumanActor(
      { kind: "human", identity: opts.triagedBy },
      "boardy_reply_triage",
    );
    const summary =
      typeof opts.summary === "string" && opts.summary.trim()
        ? opts.summary.trim()
        : null;
    const updated = (await this.prisma.connectorBoardyRequest.update({
      where: { id: requestId },
      data: {
        status: "replied",
        priorityThread: true,
        replySummary: summary,
        repliedAt: new Date(),
      },
      include: BOARDY_INCLUDES,
    })) as BoardyRequestRow & { events: BoardyRequestEventRow[] };
    await this.recordEvent(
      requestId,
      "boardy_reply_triaged",
      { kind: "human", identity: triagedBy },
      `Boardy's reply received — flagged as a PRIORITY thread for priority handling.${summary ? ` Summary: ${summary}` : ""}`,
    );
    return toBoardyRequestView(updated, await this.listEvents(requestId));
  }
}
