// Marketr — Phase 6 O1 outreach engine: sequence draft + dispatch.
//
// Depth rules (structural):
// - Depth 1: prospecting only. There are NO sending code paths — createDraft
//   and sendNextStep throw for depth-1 campaigns.
// - Depth 2: drafts only; every send is a human click. The click creates an
//   outreach_send approval bound (hash-verified) to the exact payload,
//   approved by the clicking editor, executed, then dispatched.
// - Depth 3: dispatch requires an active campaign with an executed two-person
//   depth3_activation approval + the checklist re-verified at dispatch +
//   rail checks (daily cap, CASL, suppression, bounce circuit-breaker,
//   spam ceiling). Follow-ups are depth-3 only, max 2, 48h+ cadence.
// Drafts expire after 14 days unsent. Every external send is audit-logged.

import { prisma } from "@/lib/prisma";
import { createId } from "@/lib/media/ids";
import { sha256Hex, canonicalize } from "@/lib/authority/approvals";
import { authorityApprovals, authorityAudit } from "@/lib/authority/db";
import {
  assertNotCanadaCold, assertDailyCap, bounceAction, assertSpamCeiling,
  DeliverabilityBlockedError,
} from "@/lib/authority/guards";
import { checklistInputFor, assertDepth3EnabledSafe, type DomainStore } from "./domains";
import type { CampaignStore } from "./campaigns";
import type { ProspectStore } from "./prospects";
import { isEmailSuppressed, suppressEmail, type SuppressionStore } from "./suppression";
import { fakeSpamRatePct, type DeliverabilityDeps } from "./deliverability";
import type { SendingPartner } from "@/lib/authority/fake";
import type {
  OutreachSequence, OutreachEvent, SequenceStatus, OutreachEventType,
} from "@prisma/client";

export const DRAFT_EXPIRY_DAYS = 14;
export const MAX_FOLLOWUPS = 2;
export const FOLLOWUP_CADENCE_HOURS = 48;

export interface SequenceStep {
  kind: "initial" | "followup";
  index: number;
  subject: string;
  body: string;
  status: "pending" | "sent" | "skipped";
  delayHours?: number;
  sentAt?: string;
  messageId?: string;
}

export interface SequenceStore {
  create(workspaceId: string, data: {
    campaignId: string; prospectId: string; depth: number; steps: SequenceStep[]; createdBy: string;
  }): Promise<OutreachSequence>;
  get(id: string, workspaceId: string): Promise<OutreachSequence | null>;
  list(workspaceId: string, campaignId?: string, status?: SequenceStatus): Promise<OutreachSequence[]>;
  update(id: string, workspaceId: string, data: Partial<OutreachSequence>): Promise<OutreachSequence>;
  recordEvent(sequenceId: string, workspaceId: string, event: OutreachEventType, detail?: Record<string, unknown>): Promise<OutreachEvent>;
  events(sequenceId: string, workspaceId: string): Promise<OutreachEvent[]>;
  countSentSince(workspaceId: string, campaignId: string, since: Date): Promise<number>;
  bounceRatePct(workspaceId: string, campaignId: string): Promise<number>;
}

export function approvalSecret(): string {
  const s = (process.env.AUTHORITY_APPROVAL_SECRET ?? "").trim();
  if (s) return s;
  // Fail closed in production: a hardcoded fallback secret would let anyone
  // forge approval receipts. Dev-only fallback with a loud warning.
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTHORITY_APPROVAL_SECRET is not set — refusing to sign approvals with a fallback secret.");
  }
  console.warn("[authority] WARNING: AUTHORITY_APPROVAL_SECRET unset — using insecure dev fallback. Set it before any production use.");
  return "dev-insecure-secret";
}

export function isDraftExpired(createdAt: Date, now = new Date()): boolean {
  return now.getTime() - createdAt.getTime() > DRAFT_EXPIRY_DAYS * 86_400_000;
}

function readSteps(seq: OutreachSequence): SequenceStep[] {
  const raw = seq.stepsJson;
  return Array.isArray(raw) ? (raw as unknown as SequenceStep[]) : [];
}

/** CAN-SPAM footer: one-click unsubscribe (RFC 8058) + physical address. */
export function canSpamFooter(unsubscribeUrl: string, physicalAddress: string): string {
  return `\n\n---\nUnsubscribe: ${unsubscribeUrl}\n${physicalAddress}`;
}

export function buildStepsForDepth(depth: number, initial: { subject: string; body: string }, followups?: { subject: string; body: string }[]): SequenceStep[] {
  if (depth === 2) {
    return [{ kind: "initial", index: 0, subject: initial.subject, body: initial.body, status: "pending" }];
  }
  const steps: SequenceStep[] = [{ kind: "initial", index: 0, subject: initial.subject, body: initial.body, status: "pending" }];
  for (let i = 0; i < MAX_FOLLOWUPS; i += 1) {
    const f = followups?.[i];
    steps.push({
      kind: "followup",
      index: i + 1,
      subject: f?.subject ?? `Re: ${initial.subject}`,
      body: f?.body ?? `Just bumping this up — still interested in a guest contribution?`,
      status: "pending",
      delayHours: FOLLOWUP_CADENCE_HOURS * (i + 1),
    });
  }
  return steps;
}

export interface DraftInput {
  workspaceId: string;
  campaignId: string;
  prospectId: string;
  subject: string;
  body: string;
  unsubscribeUrl: string;
  physicalAddress: string;
  followups?: { subject: string; body: string }[];
  createdBy: string;
}

/**
 * Create a draft sequence. Depth 1 throws (prospecting only — zero sending
 * code paths). Drafts expire after 14 days unsent.
 */
export async function createDraft(
  deps: { sequences: SequenceStore; campaigns: CampaignStore; prospects: ProspectStore },
  input: DraftInput,
): Promise<OutreachSequence> {
  const campaign = await deps.campaigns.get(input.campaignId, input.workspaceId);
  if (!campaign) throw new Error("Outreach campaign not found in workspace.");
  if (campaign.depth === 1) {
    throw new DeliverabilityBlockedError("depth1_no_send", "Depth 1 is prospecting only — drafts and sends are blocked.");
  }
  const prospect = await deps.prospects.get(input.prospectId, input.workspaceId);
  if (!prospect) throw new Error("Prospect not found in workspace.");
  if (prospect.campaignId !== campaign.id) throw new Error("Prospect does not belong to this campaign.");
  if (prospect.status !== "qualified") {
    throw new Error(`Prospect must be qualified before drafting (status: ${prospect.status}).`);
  }
  if (!input.subject.trim() || !input.body.trim()) throw new Error("Draft requires a subject and body.");
  if (!input.unsubscribeUrl.trim() || !input.physicalAddress.trim()) {
    throw new Error("CAN-SPAM: every template needs a one-click unsubscribe URL and a physical mailing address.");
  }

  const body = input.body.trimEnd() + canSpamFooter(input.unsubscribeUrl.trim(), input.physicalAddress.trim());
  const steps = buildStepsForDepth(
    campaign.depth,
    { subject: input.subject.trim(), body },
    input.followups?.map((f) => ({ subject: f.subject.trim(), body: f.body.trimEnd() + canSpamFooter(input.unsubscribeUrl.trim(), input.physicalAddress.trim()) })),
  );

  const seq = await deps.sequences.create(input.workspaceId, {
    campaignId: campaign.id,
    prospectId: prospect.id,
    depth: campaign.depth,
    steps,
    createdBy: input.createdBy,
  });
  await authorityAudit.logAsync({
    workspaceId: input.workspaceId, actor: input.createdBy, action: "sequence_drafted",
    entityType: "outreach_sequence", entityId: seq.id,
    detail: { campaignId: campaign.id, prospectId: prospect.id, depth: campaign.depth, steps: steps.length },
  });
  return seq;
}

export interface SendDeps {
  sequences: SequenceStore;
  campaigns: CampaignStore;
  prospects: ProspectStore;
  domains: DomainStore;
  suppression: SuppressionStore;
  partner: SendingPartner;
  deliverability?: DeliverabilityDeps;
}

export interface SendResult {
  sequence: OutreachSequence;
  stepIndex: number;
  messageId: string;
  approvalId: string | null;
}

/**
 * Send the next pending step of a sequence.
 * - Depth 2: the human click creates + approves + executes an outreach_send
 *   approval bound to the exact payload (the click IS the approval).
 * - Depth 3: requires active campaign + executed two-person depth3_activation
 *   approval; checklist re-verified at dispatch; rail checks enforced.
 */
export async function sendNextStep(
  deps: SendDeps,
  opts: { workspaceId: string; sequenceId: string; actor: string },
): Promise<SendResult> {
  const { sequences, campaigns, prospects, domains, suppression } = deps;
  const seq = await sequences.get(opts.sequenceId, opts.workspaceId);
  if (!seq) throw new Error("Sequence not found in workspace.");
  if (seq.depth === 1) {
    throw new DeliverabilityBlockedError("depth1_no_send", "Depth 1 is prospecting only — sends are blocked.");
  }
  if (seq.status === "stopped") throw new Error("Sequence stopped (reply received) — no further sends.");
  if (seq.status === "expired") throw new Error("Draft expired after 14 days unsent — re-draft to continue.");
  if (seq.status === "paused") throw new Error("Sequence paused — resolve the deliverability alert first.");
  if (seq.status === "completed") throw new Error("Sequence already completed.");

  if (isDraftExpired(seq.createdAt)) {
    await sequences.update(seq.id, opts.workspaceId, { status: "expired" });
    throw new Error("Draft expired after 14 days unsent — re-draft to continue.");
  }

  const campaign = await campaigns.get(seq.campaignId, opts.workspaceId);
  if (!campaign) throw new Error("Campaign not found in workspace.");
  const prospect = await prospects.get(seq.prospectId, opts.workspaceId);
  if (!prospect) throw new Error("Prospect not found in workspace.");
  if (!prospect.email) throw new Error("Prospect has no email address.");

  const steps = readSteps(seq);
  const next = steps.find((s) => s.status === "pending");
  if (!next) {
    await sequences.update(seq.id, opts.workspaceId, { status: "completed" });
    throw new Error("No pending steps — sequence completed.");
  }

  // Follow-up cadence: 48h+ since the previous sent step (depth 3 only has follow-ups).
  if (next.kind === "followup") {
    if (seq.depth !== 3) throw new DeliverabilityBlockedError("followup_depth3_only", "Follow-ups are depth-3 only.");
    const sentSteps = steps.filter((s) => s.status === "sent" && s.sentAt);
    const lastSent = sentSteps.length ? new Date(sentSteps[sentSteps.length - 1].sentAt as string) : null;
    if (lastSent && Date.now() - lastSent.getTime() < FOLLOWUP_CADENCE_HOURS * 3600_000) {
      throw new DeliverabilityBlockedError("followup_cadence", `Follow-ups require ${FOLLOWUP_CADENCE_HOURS}h+ cadence.`);
    }
  }

  // --- Rail checks (both depths; invariant §9.4 is law) ---
  assertNotCanadaCold(prospect.email); // CASL hard block
  if (await isEmailSuppressed(suppression, { workspaceId: opts.workspaceId, email: prospect.email, campaignId: campaign.id })) {
    await sequences.update(seq.id, opts.workspaceId, { status: "stopped", stoppedAt: new Date() });
    throw new DeliverabilityBlockedError("suppressed", "Recipient is suppressed — sequence stopped.");
  }
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const sentToday = await sequences.countSentSince(opts.workspaceId, campaign.id, dayStart);
  assertDailyCap(sentToday, campaign.dailyCap);
  const bouncePct = await sequences.bounceRatePct(opts.workspaceId, campaign.id);
  const bounce = bounceAction(bouncePct);
  if (bounce !== "ok") {
    await campaigns.update(campaign.id, opts.workspaceId, { status: "paused" });
    await authorityAudit.logAsync({
      workspaceId: opts.workspaceId, actor: "system", action: "campaign_bounce_paused",
      entityType: "outreach_campaign", entityId: campaign.id,
      detail: { bouncePct, action: bounce },
    });
    throw new DeliverabilityBlockedError(
      "bounce_circuit",
      bounce === "stop"
        ? `Bounce rate ${bouncePct}% exceeded the 5% hard stop — campaign paused.`
        : `Bounce rate ${bouncePct}% hit the 3% pause threshold — campaign paused.`,
    );
  }
  assertSpamCeiling(fakeSpamRatePct(seq.id));

  let approvalId: string | null = null;
  let fromMailbox: string;

  if (seq.depth === 2) {
    // The human click is the approval: create + submit + approve (clicker) +
    // execute against the exact payload, then dispatch.
    const binding = {
      sequenceId: seq.id, campaignId: campaign.id, prospectId: prospect.id,
      to: prospect.email, subject: next.subject, bodyHash: sha256Hex(next.body), stepIndex: next.index,
    };
    let approval = await authorityApprovals.create({
      workspaceId: opts.workspaceId, type: "outreach_send",
      bindingJson: binding, createdBy: opts.actor,
    });
    approval = await authorityApprovals.submit(approval.id, opts.workspaceId, opts.actor);
    approval = await authorityApprovals.approve(approval.id, opts.workspaceId, opts.actor, approvalSecret());
    approval = await authorityApprovals.execute(approval.id, opts.workspaceId, binding);
    approvalId = approval.id;
    fromMailbox = `outreach@${campaign.sendingDomainId ?? "marketr.local"}`;
  } else {
    // Depth 3: campaign-level rails.
    if (campaign.status !== "active") throw new Error("Depth-3 dispatch requires an active campaign.");
    if (!campaign.approvalId) throw new Error("Depth-3 dispatch requires an executed depth3_activation approval.");
    const activation = await authorityApprovals.get(campaign.approvalId, opts.workspaceId);
    if (!activation || activation.status !== "executed" || activation.type !== "depth3_activation") {
      throw new Error("Depth-3 dispatch requires an executed depth3_activation approval.");
    }
    if (!campaign.sendingDomainId) throw new Error("Depth-3 dispatch requires a sending domain.");
    const domain = await domains.get(campaign.sendingDomainId, opts.workspaceId);
    if (!domain) throw new Error("Sending domain not found in workspace.");
    assertDepth3EnabledSafe(domain); // checklist re-verified at dispatch; throws naming failures
    fromMailbox = `outreach@${domain.domain}`;
    approvalId = campaign.approvalId;
  }

  const result = await deps.partner.send({
    to: prospect.email,
    subject: next.subject,
    body: next.body,
    fromMailbox,
    campaignId: campaign.id,
    sequenceId: seq.id,
    unsubscribeUrl: "",
    physicalAddress: "",
  });

  next.status = "sent";
  next.sentAt = new Date().toISOString();
  next.messageId = result.messageId;
  const updated = await sequences.update(seq.id, opts.workspaceId, {
    stepsJson: steps as never,
    sentCount: seq.sentCount + 1,
    status: steps.every((s) => s.status !== "pending") ? "completed" : "sending",
  });
  await sequences.recordEvent(seq.id, opts.workspaceId, "sent", {
    stepIndex: next.index, kind: next.kind, messageId: result.messageId, to: prospect.email, approvalId,
  });
  if (prospect.status === "qualified") {
    await prospects.update(prospect.id, opts.workspaceId, { status: "contacted" });
  }
  await authorityAudit.logAsync({
    workspaceId: opts.workspaceId, actor: opts.actor, action: "outreach_sent",
    entityType: "outreach_sequence", entityId: seq.id,
    detail: {
      campaignId: campaign.id, prospectId: prospect.id, to: prospect.email,
      stepIndex: next.index, kind: next.kind, depth: seq.depth,
      messageId: result.messageId, approvalId, partner: deps.partner.name,
    },
  });

  return { sequence: updated, stepIndex: next.index, messageId: result.messageId, approvalId };
}

/** Stop-on-reply: halt the sequence, mark the prospect replied, suppress reply-based. */
export async function stopSequenceOnReply(
  deps: { sequences: SequenceStore; prospects: ProspectStore; suppression: SuppressionStore },
  opts: { workspaceId: string; sequenceId: string; replyId: string; replyFromEmail?: string; actor?: string },
): Promise<OutreachSequence> {
  const seq = await deps.sequences.get(opts.sequenceId, opts.workspaceId);
  if (!seq) throw new Error("Sequence not found in workspace.");
  const steps = readSteps(seq).map((s) => (s.status === "pending" ? { ...s, status: "skipped" as const } : s));
  const updated = await deps.sequences.update(seq.id, opts.workspaceId, {
    status: "stopped", stoppedAt: new Date(), replyId: opts.replyId, stepsJson: steps as never,
  });
  await deps.sequences.recordEvent(seq.id, opts.workspaceId, "replied", { replyId: opts.replyId });
  const prospect = await deps.prospects.get(seq.prospectId, opts.workspaceId);
  if (prospect) {
    await deps.prospects.update(prospect.id, opts.workspaceId, { status: "replied" });
    if (opts.replyFromEmail) {
      // Reply-based auto-suppression — instant, same cycle.
      await suppressEmail(deps.suppression, {
        workspaceId: opts.workspaceId, email: opts.replyFromEmail, kind: "global", source: "reply",
      });
    }
  }
  await authorityAudit.logAsync({
    workspaceId: opts.workspaceId, actor: opts.actor ?? "system", action: "sequence_stopped_on_reply",
    entityType: "outreach_sequence", entityId: seq.id, detail: { replyId: opts.replyId },
  });
  return updated;
}

/** Record a hard bounce: event + prospect bounced + hard-bounce quarantine. */
export async function recordHardBounce(
  deps: { sequences: SequenceStore; prospects: ProspectStore; suppression: SuppressionStore; campaigns: CampaignStore },
  opts: { workspaceId: string; sequenceId: string; email: string; detail?: Record<string, unknown> },
): Promise<void> {
  const seq = await deps.sequences.get(opts.sequenceId, opts.workspaceId);
  if (!seq) return; // unknown sequence — nothing to quarantine
  await deps.sequences.recordEvent(seq.id, opts.workspaceId, "bounced", { email: opts.email, ...(opts.detail ?? {}) });
  const prospect = await deps.prospects.get(seq.prospectId, opts.workspaceId);
  if (prospect) await deps.prospects.update(prospect.id, opts.workspaceId, { status: "bounced" });
  await suppressEmail(deps.suppression, { workspaceId: opts.workspaceId, email: opts.email, kind: "global", source: "hard_bounce" });
  await authorityAudit.logAsync({
    workspaceId: opts.workspaceId, actor: "system", action: "hard_bounce_quarantined",
    entityType: "outreach_sequence", entityId: seq.id, detail: { email: opts.email },
  });
}

// ---------------------------------------------------------------------------
// Prisma store
// ---------------------------------------------------------------------------

export function prismaSequenceStore(): SequenceStore {
  async function scoped(id: string, workspaceId: string) {
    const s = await prisma.outreachSequence.findFirst({ where: { id, workspaceId } });
    if (!s) throw new Error("Sequence not found in workspace.");
    return s;
  }
  return {
    async create(workspaceId, data) {
      return prisma.outreachSequence.create({
        data: {
          id: createId(), workspaceId, campaignId: data.campaignId, prospectId: data.prospectId,
          depth: data.depth, stepsJson: data.steps as never, status: "draft",
        },
      });
    },
    get: (id, workspaceId) => prisma.outreachSequence.findFirst({ where: { id, workspaceId } }),
    list: (workspaceId, campaignId, status) =>
      prisma.outreachSequence.findMany({
        where: { workspaceId, ...(campaignId ? { campaignId } : {}), ...(status ? { status } : {}) },
        orderBy: { createdAt: "desc" }, take: 200,
        include: { events: { orderBy: { ts: "desc" }, take: 5 } },
      }),
    async update(id, workspaceId, data) {
      await scoped(id, workspaceId);
      const { id: _id, workspaceId: _ws, createdAt: _ca, ...rest } = data;
      return prisma.outreachSequence.update({ where: { id }, data: rest as never });
    },
    async recordEvent(sequenceId, workspaceId, event, detail) {
      const d = detail ?? {};
      return prisma.outreachEvent.create({
        data: {
          id: createId(), workspaceId, sequenceId, event,
          payloadHash: sha256Hex(canonicalize(d)), detail: d as never,
        },
      });
    },
    events: (sequenceId, workspaceId) =>
      prisma.outreachEvent.findMany({ where: { sequenceId, workspaceId }, orderBy: { ts: "asc" } }),
    async countSentSince(workspaceId, campaignId, since) {
      return prisma.outreachEvent.count({
        where: { workspaceId, event: "sent", ts: { gte: since }, sequence: { campaignId } },
      });
    },
    async bounceRatePct(workspaceId, campaignId) {
      const [sent, bounced] = await Promise.all([
        prisma.outreachEvent.count({ where: { workspaceId, event: "sent", sequence: { campaignId } } }),
        prisma.outreachEvent.count({ where: { workspaceId, event: "bounced", sequence: { campaignId } } }),
      ]);
      return sent === 0 ? 0 : (bounced / sent) * 100;
    },
  };
}

// ---------------------------------------------------------------------------
// Memory store (battery twin)
// ---------------------------------------------------------------------------

export function createMemorySequenceStore(): SequenceStore {
  const rows = new Map<string, OutreachSequence>();
  const events: OutreachEvent[] = [];
  function scoped(id: string, workspaceId: string): OutreachSequence {
    const s = rows.get(id);
    if (!s || s.workspaceId !== workspaceId) throw new Error("Sequence not found in workspace.");
    return s;
  }
  return {
    async create(workspaceId, data) {
      const s = {
        id: createId(), workspaceId, campaignId: data.campaignId, prospectId: data.prospectId,
        depth: data.depth, stepsJson: data.steps as never, status: "draft" as SequenceStatus,
        sentCount: 0, replyId: null, stoppedAt: null, createdAt: new Date(),
      } satisfies OutreachSequence;
      rows.set(s.id, s);
      return s;
    },
    async get(id, workspaceId) {
      const s = rows.get(id);
      return s && s.workspaceId === workspaceId ? s : null;
    },
    async list(workspaceId, campaignId, status) {
      return [...rows.values()].filter(
        (s) => s.workspaceId === workspaceId && (!campaignId || s.campaignId === campaignId) && (!status || s.status === status),
      );
    },
    async update(id, workspaceId, data) {
      const cur = scoped(id, workspaceId);
      const next = { ...cur, ...data };
      rows.set(id, next);
      return next;
    },
    async recordEvent(sequenceId, workspaceId, event, detail) {
      const d = detail ?? {};
      const e = {
        id: createId(), workspaceId, sequenceId, ts: new Date(), event,
        payloadHash: sha256Hex(canonicalize(d)), detail: d as never,
      } satisfies OutreachEvent;
      events.push(e);
      return e;
    },
    async events(sequenceId, workspaceId) {
      return events.filter((e) => e.sequenceId === sequenceId && e.workspaceId === workspaceId);
    },
    async countSentSince(workspaceId, campaignId, since) {
      return events.filter((e) => {
        const s = rows.get(e.sequenceId);
        return e.workspaceId === workspaceId && e.event === "sent" && e.ts >= since && s?.campaignId === campaignId;
      }).length;
    },
    async bounceRatePct(workspaceId, campaignId) {
      const inCampaign = (e: OutreachEvent) => {
        const s = rows.get(e.sequenceId);
        return e.workspaceId === workspaceId && s?.campaignId === campaignId;
      };
      const sent = events.filter((e) => e.event === "sent" && inCampaign(e)).length;
      const bounced = events.filter((e) => e.event === "bounced" && inCampaign(e)).length;
      return sent === 0 ? 0 : (bounced / sent) * 100;
    },
  };
}
