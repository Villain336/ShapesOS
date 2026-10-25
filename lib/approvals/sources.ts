// ShapesOS — Phase 3 (J): the queues behind the unified "needs you" inbox.
//
// One definition per existing human-approval queue. Each source:
//   - reads ONLY pending rows of the viewer's workspace (every query carries
//     `workspaceId`; RLS-protected tables go through ctx.scoped, which pins
//     the app.workspace_id GUC);
//   - is shown only to roles that can read the queue today (viewRole mirrors
//     the queue's own GET route / page gate);
//   - computes canDecide with the queue's own decide rule (editor+, media
//     owner, skills.install, separation of duties, two-person approvals);
//   - links to the queue's existing approve/deny UI, and exposes inline
//     approve/deny only where the queue's API takes a plain POST.
//
// The inbox is a read-only roll-up: it never decides anything itself. Inline
// actions call the queues' own routes, which re-check every rule.

import type { WorkspaceRole } from "@prisma/client";
import { roleAtLeast } from "@/lib/authz";
import type {
  InboxAction,
  InboxDb,
  InboxItem,
  InboxLine,
  InboxRisk,
  InboxSourceKey,
  InboxViewer,
} from "./types";
import { INBOX_SOURCE_LABELS } from "./types";
import { runAgentName, runPrompt } from "@/lib/aos/runs";
import { clip, factLines, humanize, money } from "./format";

export { factLines, humanize };

export interface SourceContext {
  db: InboxDb;
  /** Run fn with the viewer's workspace pinned for RLS-protected tables. */
  scoped: <T>(fn: (tx: InboxDb) => Promise<T>) => Promise<T>;
  viewer: InboxViewer;
  now: Date;
  limit: number;
}

export interface InboxSource {
  key: InboxSourceKey;
  /** Minimum workspace role that can read this queue today. */
  viewRole: WorkspaceRole;
  load(ctx: SourceContext): Promise<InboxItem[]>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function post(url: string, body: Record<string, unknown> = {}): InboxAction {
  return { method: "POST", url, body };
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

const enc = encodeURIComponent;

interface ItemInput {
  id: string;
  source: InboxSourceKey;
  typeLabel?: string;
  title: string;
  detail?: string | null;
  requestedBy?: string | null;
  createdAt: Date;
  expiresAt?: Date | null;
  risk: InboxRisk;
  href: string;
  canDecide: boolean;
  blockedReason?: string | null;
  approve?: InboxAction | null;
  deny?: InboxAction | null;
  agent?: string | null;
  missionId?: string | null;
  missionName?: string | null;
  lines?: InboxLine[];
  lineTotal?: number;
}

/** Normalize an item; inline actions are dropped when the viewer can't decide. */
export function makeItem(i: ItemInput): InboxItem {
  return {
    key: `${i.source}:${i.id}`,
    id: i.id,
    source: i.source,
    typeLabel: i.typeLabel ?? INBOX_SOURCE_LABELS[i.source],
    title: clip(i.title, 160) ?? INBOX_SOURCE_LABELS[i.source],
    detail: clip(i.detail ?? null),
    requestedBy: i.requestedBy ?? null,
    requester: null,
    createdAt: i.createdAt.toISOString(),
    expiresAt: iso(i.expiresAt),
    risk: i.risk,
    href: i.href,
    canDecide: i.canDecide,
    blockedReason: i.canDecide ? null : (i.blockedReason ?? "Your role can view this but not decide it."),
    approve: i.canDecide ? (i.approve ?? null) : null,
    deny: i.canDecide ? (i.deny ?? null) : null,
    agent: i.agent ?? null,
    missionId: i.missionId ?? null,
    missionName: i.missionName ?? null,
    lines: i.lines ?? [],
    lineTotal: Math.max(i.lineTotal ?? 0, i.lines?.length ?? 0),
  };
}

const EDITOR_REASON = "Needs an editor or above to decide.";

function isEditor(v: InboxViewer): boolean {
  return roleAtLeast(v.role, "editor");
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Mission approvals (Phase 9) — RLS table; decided via /api/automation/decide. */
const mission: InboxSource = {
  key: "mission",
  viewRole: "viewer",
  async load(ctx) {
    const { viewer } = ctx;
    const rows = await ctx.scoped((tx) =>
      tx.missionApproval.findMany({
        where: { workspaceId: viewer.workspaceId, status: "pending", expiresAt: { gt: ctx.now } },
        orderBy: { createdAt: "desc" },
        take: ctx.limit,
        select: {
          id: true,
          missionId: true,
          action: true,
          tier: true,
          bindingJson: true,
          createdBy: true,
          createdAt: true,
          expiresAt: true,
          mission: { select: { template: true, goal: true } },
        },
      }),
    );
    const canDecide = isEditor(viewer);
    return rows.map((r) => {
      const amount = (r.bindingJson as Record<string, unknown> | null)?.amountCents;
      const amountLabel = typeof amount === "number" ? money(amount) : null;
      const goalLabel = (r.mission?.goal as { label?: unknown } | null)?.label;
      const facts = factLines(r.bindingJson);
      return makeItem({
        id: r.id,
        source: "mission",
        typeLabel: `Mission · tier ${r.tier}`,
        title: humanize(r.action),
        detail: [r.mission?.template ? humanize(r.mission.template) : null, amountLabel].filter(Boolean).join(" · ") || null,
        requestedBy: r.createdBy,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        risk: r.tier >= 3 ? "high" : r.tier === 2 ? "medium" : "low",
        href: r.missionId ? `/dashboard/missions/${enc(r.missionId)}` : "/dashboard/approvals?source=mission",
        canDecide,
        blockedReason: EDITOR_REASON,
        approve: post("/api/automation/decide", { approvalId: r.id, missionId: r.missionId, decision: "approved" }),
        deny: post("/api/automation/decide", { approvalId: r.id, missionId: r.missionId, decision: "denied" }),
        missionId: r.missionId,
        missionName:
          typeof goalLabel === "string" && goalLabel.trim()
            ? goalLabel.trim()
            : r.mission?.template
              ? humanize(r.mission.template.split(".").pop() ?? r.mission.template)
              : null,
        lines: facts.lines,
        lineTotal: facts.total,
      });
    });
  },
};

/** Ad-spend proposals (Phase 18) — the proposals page is editor+ and decides via server actions. */
const spend: InboxSource = {
  key: "spend",
  viewRole: "editor",
  async load(ctx) {
    const rows = await ctx.db.spendProposal.findMany({
      where: { workspaceId: ctx.viewer.workspaceId, status: "pending", expiresAt: { gt: ctx.now } },
      orderBy: { createdAt: "desc" },
      take: ctx.limit,
      select: {
        id: true,
        kind: true,
        action: true,
        targetType: true,
        targetId: true,
        proposedBy: true,
        createdAt: true,
        expiresAt: true,
      },
    });
    return rows.map((r) =>
      makeItem({
        id: r.id,
        source: "spend",
        typeLabel: `Ad spend · ${humanize(r.kind)}`,
        title: `${humanize(r.action)} ${r.targetType}`,
        detail: r.targetId,
        requestedBy: r.proposedBy,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        risk: "high",
        href: "/dashboard/media/advertising/proposals?status=pending",
        canDecide: isEditor(ctx.viewer),
        blockedReason: EDITOR_REASON,
      }),
    );
  },
};

const AUTHORITY_LINKS: Record<string, string> = {
  outreach_send: "/dashboard/authority/outreach",
  depth3_activation: "/dashboard/authority/outreach",
  pr_send: "/dashboard/authority/pr",
  listing_edit: "/dashboard/authority/listings",
  review_reply_post: "/dashboard/authority/reviews",
  aeo_content_fix: "/dashboard/authority/aeo",
};

/** Authority approvals: outreach sends, PR sends, listings, review replies, AEO fixes. */
const authority: InboxSource = {
  key: "authority",
  viewRole: "viewer",
  async load(ctx) {
    const { viewer } = ctx;
    const rows = await ctx.db.authorityApproval.findMany({
      where: { workspaceId: viewer.workspaceId, status: "pending" },
      orderBy: { createdAt: "desc" },
      take: ctx.limit,
      select: {
        id: true,
        type: true,
        bindingJson: true,
        approversJson: true,
        twoPersonRequired: true,
        createdBy: true,
        createdAt: true,
        expiresAt: true,
      },
    });
    return rows
      .filter((r) => !r.expiresAt || r.expiresAt > ctx.now)
      .map((r) => {
        const approvers = Array.isArray(r.approversJson) ? (r.approversJson as string[]) : [];
        const already = approvers.includes(viewer.userId);
        const binding = (r.bindingJson ?? {}) as Record<string, unknown>;
        const subject =
          [binding.subject, binding.title, binding.name, binding.listingName, binding.target]
            .find((v): v is string => typeof v === "string" && v.trim().length > 0) ?? null;
        return makeItem({
          id: r.id,
          source: "authority",
          typeLabel: humanize(r.type),
          title: subject ?? humanize(r.type),
          detail: r.twoPersonRequired ? `Two approvers required · ${approvers.length} of 2` : null,
          requestedBy: r.createdBy,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          risk: r.twoPersonRequired ? "high" : "medium",
          href: AUTHORITY_LINKS[r.type] ?? "/dashboard/authority",
          canDecide: isEditor(viewer) && !already,
          blockedReason: already ? "You already approved — a second approver is needed." : EDITOR_REASON,
          approve: post(`/api/authority/approvals/${enc(r.id)}/approve`),
          deny: post(`/api/authority/approvals/${enc(r.id)}/reject`),
        });
      });
  },
};

const MESSAGING_TYPES: Record<string, { label: string; href: string }> = {
  sequence_send: { label: "Nurture send", href: "/dashboard/nurture?tab=approvals" },
  broadcast: { label: "Broadcast", href: "/dashboard/nurture?tab=approvals" },
  review_request: { label: "Review request", href: "/dashboard/reviews" },
  review_response: { label: "Review reply", href: "/dashboard/reviews" },
  prospect_export: { label: "Prospect export", href: "/dashboard/prospects" },
};

function approvalItemTitle(kind: string, payload: Record<string, unknown>): string {
  const pick = (...keys: string[]) =>
    keys.map((k) => payload[k]).find((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (kind === "prospect_export") {
    const n = Array.isArray(payload.prospectIds) ? payload.prospectIds.length : 0;
    return `Export ${n} prospect${n === 1 ? "" : "s"} to ${pick("sequenceName") ?? "a sequence"}`;
  }
  const to = pick("to", "recipient", "leadName", "email", "phone");
  const subject = pick("subject", "title", "summary");
  if (subject && to) return `${subject} → ${to}`;
  return subject ?? (to ? `Send to ${to}` : (MESSAGING_TYPES[kind]?.label ?? humanize(kind)));
}

/** The generic ApprovalItem queue: nurture, messaging, reviews, prospect exports. */
const messaging: InboxSource = {
  key: "messaging",
  viewRole: "viewer",
  async load(ctx) {
    const rows = await ctx.db.approvalItem.findMany({
      where: { workspaceId: ctx.viewer.workspaceId, status: "pending", NOT: { kind: { startsWith: "insurance_" } } },
      orderBy: { createdAt: "desc" },
      take: ctx.limit,
      select: { id: true, kind: true, payload: true, requestedBy: true, createdAt: true },
    });
    return rows.map((r) => {
      const payload = (r.payload ?? {}) as Record<string, unknown>;
      const meta = MESSAGING_TYPES[r.kind] ?? { label: humanize(r.kind), href: "/dashboard/nurture?tab=approvals" };
      const channel = typeof payload.channel === "string" ? payload.channel.toUpperCase() : null;
      const body = typeof payload.body === "string" ? payload.body : null;
      const to = ["to", "recipient", "leadName", "email", "phone"]
        .map((k) => payload[k])
        .find((v): v is string => typeof v === "string" && v.trim().length > 0);
      const lines: InboxLine[] = [
        ...(to ? [{ label: "To", detail: clip(to, 80) }] : []),
        ...(channel ? [{ label: "Channel", detail: channel }] : []),
      ];
      return makeItem({
        id: r.id,
        source: "messaging",
        typeLabel: meta.label,
        title: approvalItemTitle(r.kind, payload),
        detail: [channel, body].filter(Boolean).join(" · ") || null,
        requestedBy: r.requestedBy,
        createdAt: r.createdAt,
        risk: r.kind === "prospect_export" || r.kind === "broadcast" ? "high" : "medium",
        href: meta.href,
        canDecide: isEditor(ctx.viewer),
        blockedReason: EDITOR_REASON,
        approve: post(`/api/messaging/approvals/${enc(r.id)}`, { decision: "approve" }),
        deny: post(`/api/messaging/approvals/${enc(r.id)}`, { decision: "reject" }),
        lines,
      });
    });
  },
};

/** Insurance governed actions (ApprovalItem insurance_*); the pending API is editor+. */
const insurance: InboxSource = {
  key: "insurance",
  viewRole: "editor",
  async load(ctx) {
    const rows = await ctx.db.approvalItem.findMany({
      where: { workspaceId: ctx.viewer.workspaceId, status: "pending", kind: { startsWith: "insurance_" } },
      orderBy: { createdAt: "desc" },
      take: ctx.limit,
      select: { id: true, kind: true, payload: true, requestedBy: true, createdAt: true },
    });
    return rows.map((r) => {
      const action = r.kind.replace(/^insurance_/, "");
      const payload = (r.payload ?? {}) as Record<string, unknown>;
      const summary = typeof payload.summary === "string" ? payload.summary : null;
      return makeItem({
        id: r.id,
        source: "insurance",
        typeLabel: `Insurance · ${humanize(action)}`,
        title: summary ?? humanize(action),
        requestedBy: r.requestedBy,
        createdAt: r.createdAt,
        risk: action === "bind_policy" ? "high" : "medium",
        href: "/dashboard/insurance",
        canDecide: isEditor(ctx.viewer),
        blockedReason: EDITOR_REASON,
        approve: post(`/api/insurance/governance/${enc(r.id)}/decide`, { decision: "approve" }),
        deny: post(`/api/insurance/governance/${enc(r.id)}/decide`, { decision: "reject" }),
      });
    });
  },
};

/** Supervised scheduled-skill runs awaiting approval (skills.install or admin+). */
const scheduler: InboxSource = {
  key: "scheduler",
  viewRole: "viewer",
  async load(ctx) {
    const { viewer } = ctx;
    const rows = await ctx.db.skillRun.findMany({
      where: { workspaceId: viewer.workspaceId, status: "awaiting_approval" },
      orderBy: { startedAt: "desc" },
      take: ctx.limit,
      select: {
        id: true,
        projectId: true,
        trigger: true,
        startedAt: true,
        skill: { select: { name: true } },
        schedule: { select: { createdBy: true } },
      },
    });
    const canDecide = viewer.permissions.has("skills.install") || roleAtLeast(viewer.role, "admin");
    return rows.map((r) =>
      makeItem({
        id: r.id,
        source: "scheduler",
        typeLabel: `Scheduled run · ${humanize(r.trigger)}`,
        title: `Run ${r.skill?.name ?? "skill"}`,
        agent: r.skill?.name ?? null,
        requestedBy: r.schedule?.createdBy ?? null,
        createdAt: r.startedAt,
        risk: "medium",
        href: r.projectId
          ? `/dashboard/projects/${enc(r.projectId)}/automations/schedules/runs/${enc(r.id)}`
          : "/dashboard/approvals?source=scheduler",
        canDecide,
        blockedReason: "Needs the skills.install permission or admin to decide.",
        approve: post(`/api/scheduler/runs/${enc(r.id)}/approve`, { workspaceId: viewer.workspaceId }),
        deny: post(`/api/scheduler/runs/${enc(r.id)}/reject`, { workspaceId: viewer.workspaceId }),
      }),
    );
  },
};

/** Branded report sends (Phase 16) — RLS table; flagged = figures lack sources. */
const report: InboxSource = {
  key: "report",
  viewRole: "viewer",
  async load(ctx) {
    const rows = await ctx.scoped((tx) =>
      tx.reportSendApproval.findMany({
        where: { workspaceId: ctx.viewer.workspaceId, status: { in: ["pending", "flagged"] } },
        orderBy: { createdAt: "desc" },
        take: ctx.limit,
        select: {
          id: true,
          clientName: true,
          period: true,
          templateName: true,
          status: true,
          reviewNote: true,
          createdBy: true,
          createdAt: true,
        },
      }),
    );
    return rows.map((r) =>
      makeItem({
        id: r.id,
        source: "report",
        typeLabel: r.status === "flagged" ? "Report send · flagged" : "Report send",
        title: `${r.clientName} · ${r.period}`,
        detail: r.status === "flagged" ? (r.reviewNote ?? "Some figures have no source.") : humanize(r.templateName),
        requestedBy: r.createdBy,
        createdAt: r.createdAt,
        risk: r.status === "flagged" ? "high" : "low",
        href: "/dashboard/reports",
        canDecide: isEditor(ctx.viewer),
        blockedReason: EDITOR_REASON,
        approve: post(`/api/reports/send-approvals/${enc(r.id)}/approve`),
        deny: post(`/api/reports/send-approvals/${enc(r.id)}/deny`),
      }),
    );
  },
};

/** CAD design-change proposals (draft = awaiting a human decision). */
const cad: InboxSource = {
  key: "cad",
  viewRole: "viewer",
  async load(ctx) {
    const rows = await ctx.db.cadDesignProposal.findMany({
      where: { workspaceId: ctx.viewer.workspaceId, status: "draft" },
      orderBy: { requestedAt: "desc" },
      take: ctx.limit,
      select: {
        id: true,
        requestedText: true,
        requestedBy: true,
        requestedAt: true,
        operation: true,
        parseConfidence: true,
        model: { select: { name: true } },
      },
    });
    return rows.map((r) =>
      makeItem({
        id: r.id,
        source: "cad",
        typeLabel: `CAD change · ${humanize(r.operation)}`,
        title: r.requestedText,
        detail: [r.model?.name, `Parse confidence ${r.parseConfidence}`].filter(Boolean).join(" · "),
        requestedBy: r.requestedBy,
        createdAt: r.requestedAt,
        risk: r.parseConfidence === "low" ? "high" : r.parseConfidence === "medium" ? "medium" : "low",
        href: "/dashboard/cad",
        canDecide: isEditor(ctx.viewer),
        blockedReason: EDITOR_REASON,
        approve: post(`/api/cad/proposals/${enc(r.id)}/approve`),
        deny: post(`/api/cad/proposals/${enc(r.id)}/reject`),
      }),
    );
  },
};

/** Connector introductions: drafts awaiting tenant approval + follow-up drafts. Deep link only (the send needs a channel). */
const intro: InboxSource = {
  key: "intro",
  viewRole: "viewer",
  async load(ctx) {
    const rows = await ctx.db.connectorIntroduction.findMany({
      where: {
        workspaceId: ctx.viewer.workspaceId,
        OR: [
          { status: "proposed", tenantApproved: false },
          { status: { in: ["made", "followed_up"] }, pendingFollowupDraft: { not: null } },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: ctx.limit,
      select: {
        id: true,
        status: true,
        mode: true,
        createdAt: true,
        updatedAt: true,
        draftAskMessage: true,
        pendingFollowupDraft: true,
        personA: { select: { name: true } },
        personB: { select: { name: true } },
      },
    });
    return rows.map((r) => {
      const followup = r.status !== "proposed";
      return makeItem({
        id: r.id,
        source: "intro",
        typeLabel: followup ? "Introduction · follow-up" : `Introduction · ${humanize(r.mode)}`,
        title: `Ask ${r.personA?.name ?? "a contact"} to introduce ${r.personB?.name ?? "a target"}`,
        detail: followup ? r.pendingFollowupDraft : r.draftAskMessage,
        requestedBy: "agent:connector",
        agent: "Connector",
        createdAt: followup ? r.updatedAt : r.createdAt,
        risk: r.mode === "funding" ? "high" : "medium",
        href: "/dashboard/connector",
        canDecide: isEditor(ctx.viewer),
        blockedReason: EDITOR_REASON,
      });
    });
  },
};

/** Boardy introduction requests drafted by the connector agent. */
const boardy: InboxSource = {
  key: "boardy",
  viewRole: "viewer",
  async load(ctx) {
    const rows = await ctx.db.connectorBoardyRequest.findMany({
      where: { workspaceId: ctx.viewer.workspaceId, status: "draft" },
      orderBy: { createdAt: "desc" },
      take: ctx.limit,
      select: { id: true, targetName: true, draftedSubject: true, createdAt: true, mode: true },
    });
    return rows.map((r) =>
      makeItem({
        id: r.id,
        source: "boardy",
        title: r.draftedSubject || `Request an intro to ${r.targetName}`,
        detail: `Target: ${r.targetName}`,
        requestedBy: "agent:connector",
        agent: "Connector",
        createdAt: r.createdAt,
        risk: r.mode === "funding" ? "high" : "medium",
        href: "/dashboard/connector",
        canDecide: isEditor(ctx.viewer),
        blockedReason: EDITOR_REASON,
      }),
    );
  },
};

/** E-sign: agent-prepared drafts waiting at the send gate + unapproved signer nudges. */
const esign: InboxSource = {
  key: "esign",
  viewRole: "viewer",
  async load(ctx) {
    const ws = ctx.viewer.workspaceId;
    const [drafts, nudgeEvents] = await Promise.all([
      ctx.db.esignEnvelope.findMany({
        // Agent-prepared drafts (prepareEnvelopeDraft writes this event); a
        // human's own drafts are their work in progress, not an approval.
        where: { workspaceId: ws, status: "draft", events: { some: { event: "agent_draft_prepared" } } },
        orderBy: { createdAt: "desc" },
        take: ctx.limit,
        select: { id: true, title: true, documentName: true, createdBy: true, createdAt: true },
      }),
      ctx.db.esignAuditEvent.findMany({
        where: {
          envelope: { workspaceId: ws, status: { in: ["sent", "partially-signed"] } },
          event: { in: ["nudge_drafted", "nudge_approved"] },
        },
        orderBy: { createdAt: "desc" },
        take: ctx.limit * 4,
        select: {
          id: true,
          event: true,
          actor: true,
          payload: true,
          createdAt: true,
          envelope: { select: { id: true, title: true } },
        },
      }),
    ]);
    const released = new Set(
      nudgeEvents
        .filter((e) => e.event === "nudge_approved")
        .map((e) => (e.payload as { nudgeId?: string } | null)?.nudgeId)
        .filter(Boolean),
    );
    const canDecide = isEditor(ctx.viewer);
    const items: InboxItem[] = drafts.map((d) =>
      makeItem({
        id: d.id,
        source: "esign",
        typeLabel: "E-sign · ready to send",
        title: d.title,
        detail: d.documentName,
        requestedBy: d.createdBy,
        createdAt: d.createdAt,
        risk: "medium",
        href: "/dashboard/esign",
        canDecide,
        blockedReason: EDITOR_REASON,
      }),
    );
    for (const e of nudgeEvents) {
      if (e.event !== "nudge_drafted") continue;
      const p = (e.payload ?? {}) as { nudgeId?: string; email?: string };
      if (!p.nudgeId || released.has(p.nudgeId)) continue;
      items.push(
        makeItem({
          id: e.id,
          source: "esign",
          typeLabel: "E-sign · signer reminder",
          title: `Remind ${p.email ?? "a signer"} to sign ${e.envelope.title}`,
          requestedBy: e.actor,
          createdAt: e.createdAt,
          risk: "low",
          href: "/dashboard/esign",
          canDecide,
          blockedReason: EDITOR_REASON,
        }),
      );
    }
    return items.slice(0, ctx.limit);
  },
};

/** Integration (Composio) tool actions, incl. operations gated writes — RLS table. */
const integration: InboxSource = {
  key: "integration",
  viewRole: "viewer",
  async load(ctx) {
    const { viewer } = ctx;
    const rows = await ctx.scoped((tx) =>
      tx.composioActionApproval.findMany({
        where: { workspaceId: viewer.workspaceId, status: "pending", expiresAt: { gt: ctx.now } },
        orderBy: { createdAt: "desc" },
        take: ctx.limit,
        select: {
          id: true,
          appKey: true,
          toolName: true,
          riskTier: true,
          plainSummary: true,
          auditTrail: true,
          createdAt: true,
          expiresAt: true,
        },
      }),
    );
    return rows.map((r) => {
      const requester = requesterOfTrail(r.auditTrail);
      const own = isRequesterId(requester, viewer.userId);
      const blockedBySoD = own && viewer.hasOtherApprover;
      const risk: InboxRisk = r.riskTier === "high" ? "high" : r.riskTier === "low" ? "low" : "medium";
      return makeItem({
        id: r.id,
        source: "integration",
        typeLabel: `Tool action · ${r.appKey}`,
        title: r.plainSummary || humanize(r.toolName),
        detail: r.toolName,
        requestedBy: requester,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        risk,
        href: "/dashboard/actions",
        canDecide: isEditor(viewer) && !blockedBySoD,
        blockedReason: blockedBySoD ? "You requested this — another approver must decide." : EDITOR_REASON,
        approve: post(`/api/integrations/actions/approvals/${enc(r.id)}/decide`, { decision: "approved" }),
        deny: post(`/api/integrations/actions/approvals/${enc(r.id)}/decide`, { decision: "denied" }),
      });
    });
  },
};

/** Requester of a Composio approval: the actor of its server-written "proposed" event. */
export function requesterOfTrail(auditTrail: unknown): string | null {
  const arr = Array.isArray(auditTrail) ? (auditTrail as Array<{ event?: string; actor?: string }>) : [];
  return arr.find((e) => e?.event === "proposed")?.actor ?? null;
}

/** Same rule as lib/integrations/actions/gate.ts isRequester ("<userId> (playbook:…)" forms). */
export function isRequesterId(requester: string | null, userId: string): boolean {
  if (!requester || !userId) return false;
  return requester === userId || requester.startsWith(`${userId} `);
}

/** Per-buy media approvals (Phase 5 SAFETY): only the media owner (admin+) approves; OTP lives in the detail page. */
const media: InboxSource = {
  key: "media",
  viewRole: "viewer",
  async load(ctx) {
    const rows = await ctx.db.mediaApproval.findMany({
      where: { workspaceId: ctx.viewer.workspaceId, status: "pending" },
      orderBy: { createdAt: "desc" },
      take: ctx.limit,
      select: {
        id: true,
        type: true,
        bindingJson: true,
        maxSpendCents: true,
        createdBy: true,
        createdAt: true,
        approvalsExpiresAt: true,
      },
    });
    const owner = roleAtLeast(ctx.viewer.role, "admin");
    return rows.map((r) => {
      const b = (r.bindingJson ?? {}) as Record<string, unknown>;
      const platform = typeof b.platform === "string" ? b.platform : null;
      return makeItem({
        id: r.id,
        source: "media",
        typeLabel: `Media buy · ${humanize(r.type)}`,
        title: [platform, money(r.maxSpendCents)].filter(Boolean).join(" · ") || humanize(r.type),
        detail: typeof b.campaignName === "string" ? b.campaignName : null,
        requestedBy: r.createdBy,
        createdAt: r.createdAt,
        expiresAt: r.approvalsExpiresAt,
        risk: r.maxSpendCents >= 100_000 ? "high" : "medium",
        href: `/dashboard/media/approvals/${enc(r.id)}`,
        canDecide: owner,
        blockedReason: "Only the media owner (admin or owner) approves buys.",
      });
    });
  },
};

/** Direct-mail campaign approvals (piece count + spend ceiling). */
const mail: InboxSource = {
  key: "mail",
  viewRole: "viewer",
  async load(ctx) {
    const rows = await ctx.db.mailApproval.findMany({
      where: { status: "pending", campaign: { workspaceId: ctx.viewer.workspaceId } },
      orderBy: { createdAt: "desc" },
      take: ctx.limit,
      select: {
        id: true,
        pieceCount: true,
        maxSpendCents: true,
        createdAt: true,
        campaign: { select: { name: true } },
      },
    });
    return rows.map((r) =>
      makeItem({
        id: r.id,
        source: "mail",
        title: r.campaign?.name ?? "Direct mail campaign",
        detail: `${r.pieceCount.toLocaleString("en-US")} pieces · up to ${money(r.maxSpendCents)}`,
        requestedBy: null,
        createdAt: r.createdAt,
        risk: r.maxSpendCents >= 100_000 ? "high" : "medium",
        href: "/dashboard/direct-mail",
        canDecide: isEditor(ctx.viewer),
        blockedReason: EDITOR_REASON,
        approve: post(`/api/mail/approvals/${enc(r.id)}`, { decision: "approve" }),
        deny: post(`/api/mail/approvals/${enc(r.id)}`, { decision: "reject" }),
      }),
    );
  },
};

/**
 * Social posts (Phase 4b) — RLS table; decided via /api/social/posts/[id]/decision.
 * Editor+, and not your own submission while another approver exists.
 */
const social: InboxSource = {
  key: "social",
  viewRole: "viewer",
  async load(ctx) {
    const rows = await ctx.scoped((tx) =>
      tx.socialPublication.findMany({
        where: { workspaceId: ctx.viewer.workspaceId, status: "pending_approval" },
        orderBy: { requestedAt: "desc" },
        take: ctx.limit,
        select: {
          id: true,
          content: true,
          media: true,
          channels: true,
          publishMode: true,
          scheduledFor: true,
          requestedBy: true,
          requestedAt: true,
          createdAt: true,
        },
      }),
    );
    return rows.map((r) => {
      const channels = Array.isArray(r.channels) ? (r.channels as Array<{ name?: unknown }>) : [];
      const mediaCount = Array.isArray(r.media) ? r.media.length : 0;
      const own = !!r.requestedBy && r.requestedBy === ctx.viewer.userId;
      const blockedBySoD = own && ctx.viewer.hasOtherApprover;
      const text = r.content.replace(/\s+/g, " ").trim();
      const when =
        r.publishMode === "schedule" && r.scheduledFor
          ? `scheduled ${r.scheduledFor.toISOString().slice(0, 16).replace("T", " ")} UTC`
          : "publishes on approval";
      return makeItem({
        id: r.id,
        source: "social",
        typeLabel: mediaCount ? "Social post · media" : "Social post",
        title: text || `Media post (${mediaCount})`,
        detail: [
          channels.map((c) => (typeof c.name === "string" ? c.name : null)).filter(Boolean).join(", ") || null,
          when,
        ]
          .filter(Boolean)
          .join(" · "),
        requestedBy: r.requestedBy,
        createdAt: r.requestedAt ?? r.createdAt,
        risk: "medium",
        href: `/dashboard/social?post=${enc(r.id)}`,
        canDecide: isEditor(ctx.viewer) && !blockedBySoD,
        blockedReason: blockedBySoD ? "Someone else approves posts you submit." : EDITOR_REASON,
        approve: post(`/api/social/posts/${enc(r.id)}/decision`, { decision: "approve" }),
        deny: post(`/api/social/posts/${enc(r.id)}/decision`, { decision: "deny" }),
      });
    });
  },
};

// ---------------------------------------------------------------------------
// Phase 18.3 (WS=trust): the 16th and 17th sources — one approvals queue.
// Both are pending AutopilotItems; a workflow canvas approval gate enqueues
// its item with sourceRef "workflow_run:<runId>:<nodeId>" (lib/workflow/
// approvals.ts) so the WorkflowRun waiting_approval resumes or cancels when
// the item is decided. Decisions go through the EXISTING autopilot routes
// (/api/autopilot/items/[id]/approve|reject { projectId }), which call
// approveAutopilotItem / rejectAutopilotItem (kill switch, audit, gate resume).
// ---------------------------------------------------------------------------

const AUTOPILOT_KIND_LABELS: Record<string, string> = {
  keyword_brief: "Content brief",
  decay_refresh: "Content refresh",
  programmatic_page: "Programmatic page",
};

/** True for a workflow approval gate's item ("workflow_run:<runId>:<nodeId>"). */
export function isWorkflowGateRef(sourceRef: string): boolean {
  return /^workflow_run:[^:]+:[^:]+$/.test(sourceRef);
}

const AUTOPILOT_SELECT = {
  id: true,
  kind: true,
  sourceRef: true,
  title: true,
  reviewNote: true,
  createdAt: true,
  projectId: true,
  project: { select: { domain: true } },
  rule: { select: { name: true } },
  run: { select: { createdBy: true } },
} as const;

function autopilotActions(id: string, projectId: string): { approve: InboxAction; deny: InboxAction } {
  return {
    approve: post(`/api/autopilot/items/${enc(id)}/approve`, { projectId }),
    deny: post(`/api/autopilot/items/${enc(id)}/reject`, { projectId }),
  };
}

/** Autopilot drafts waiting for review (Phase 14 gate) — editor+ decides. */
const autopilot: InboxSource = {
  key: "autopilot",
  viewRole: "viewer",
  async load(ctx) {
    const rows = await ctx.db.autopilotItem.findMany({
      where: {
        status: "pending",
        project: { workspaceId: ctx.viewer.workspaceId },
        NOT: { sourceRef: { startsWith: "workflow_run:" } },
      },
      orderBy: { createdAt: "desc" },
      take: ctx.limit,
      select: AUTOPILOT_SELECT,
    });
    return rows
      .filter((r) => !isWorkflowGateRef(r.sourceRef))
      .map((r) =>
        makeItem({
          id: r.id,
          source: "autopilot",
          typeLabel: AUTOPILOT_KIND_LABELS[r.kind] ?? "Autopilot draft",
          title: r.title,
          detail: [r.rule?.name, r.project?.domain].filter(Boolean).join(" · ") || null,
          requestedBy: r.run?.createdBy && r.run.createdBy !== "workflow" ? r.run.createdBy : "agent:autopilot",
          createdAt: r.createdAt,
          risk: r.kind === "programmatic_page" ? "medium" : "low",
          href: `/dashboard/projects/${enc(r.projectId)}/autopilot`,
          canDecide: isEditor(ctx.viewer),
          blockedReason: EDITOR_REASON,
          agent: "Autopilot",
          ...autopilotActions(r.id, r.projectId),
        }),
      );
  },
};

/** Workflow canvas approval gates (a WorkflowRun paused at waiting_approval). */
const workflow: InboxSource = {
  key: "workflow",
  viewRole: "viewer",
  async load(ctx) {
    const rows = await ctx.db.autopilotItem.findMany({
      where: {
        status: "pending",
        project: { workspaceId: ctx.viewer.workspaceId },
        sourceRef: { startsWith: "workflow_run:" },
      },
      orderBy: { createdAt: "desc" },
      take: ctx.limit,
      select: AUTOPILOT_SELECT,
    });
    const gates = rows.filter((r) => isWorkflowGateRef(r.sourceRef));
    const runIds = gates.map((r) => r.sourceRef.split(":")[1]!);
    const runs = runIds.length
      ? await ctx.db.workflowRun.findMany({
          where: { id: { in: runIds }, project: { workspaceId: ctx.viewer.workspaceId } },
          select: { id: true, status: true, createdBy: true, triggerKind: true, workflowId: true, workflow: { select: { name: true } } },
        })
      : [];
    const byRun = new Map(runs.map((r) => [r.id, r]));
    return gates.map((r) => {
      const run = byRun.get(r.sourceRef.split(":")[1]!);
      return makeItem({
        id: r.id,
        source: "workflow",
        typeLabel: "Workflow approval gate",
        title: r.title.replace(/^Workflow approval:\s*/, "") || r.title,
        detail: [run?.workflow?.name, r.project?.domain, r.reviewNote].filter(Boolean).join(" · ") || null,
        requestedBy: run?.createdBy ?? null,
        createdAt: r.createdAt,
        risk: "medium",
        href: `/dashboard/projects/${enc(r.projectId)}/automations${run ? `?run=${enc(run.id)}` : ""}`,
        canDecide: isEditor(ctx.viewer),
        blockedReason: EDITOR_REASON,
        agent: "Workflow",
        lines: run ? [{ label: "Started by", detail: run.triggerKind }] : [],
        ...autopilotActions(r.id, r.projectId),
      });
    });
  },
};

/** Oct 2026 (comparison follow-up): agent runs paused at awaiting_confirmation
 * — the lead or a delegated sub-agent holding a proposal for a person's OK.
 * The card is a signpost, not a decision: the diff and Approve / Reject /
 * Ask-for-changes / Undo live on the run review it links to. RLS table. */
const agentrun: InboxSource = {
  key: "agent_run",
  viewRole: "viewer",
  async load(ctx) {
    const { viewer } = ctx;
    const rows = await ctx.scoped((tx) =>
      tx.agentRun.findMany({
        where: { workspaceId: viewer.workspaceId, status: "awaiting_confirmation" },
        orderBy: { createdAt: "desc" },
        take: ctx.limit,
        select: {
          id: true,
          kind: true,
          agentKey: true,
          startedBy: true,
          agentState: true,
          createdAt: true,
        },
      }),
    );
    return rows.map((r) =>
      makeItem({
        id: r.id,
        source: "agent_run",
        typeLabel: "Run review",
        title: runPrompt(r.agentState) ?? `${humanize(r.agentKey)} run`,
        detail: humanize(r.kind),
        requestedBy: r.startedBy && !r.startedBy.includes(":") ? r.startedBy : runAgentName(r.kind, r.agentKey),
        createdAt: r.createdAt,
        risk: "medium",
        href: `/dashboard/runs/${enc(r.id)}`,
        canDecide: isEditor(viewer),
        blockedReason: EDITOR_REASON,
        // No inline actions: the decision needs the run's diff, so the card
        // leads to the review screen instead of approving blind.
      }),
    );
  },
};

export const INBOX_SOURCE_DEFS: readonly InboxSource[] = [
  mission,
  spend,
  authority,
  messaging,
  insurance,
  scheduler,
  report,
  cad,
  intro,
  boardy,
  esign,
  integration,
  media,
  mail,
  social,
  // Phase 18.3 (WS=trust)
  autopilot,
  workflow,
  agentrun,
];
