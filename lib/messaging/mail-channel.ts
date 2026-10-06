// Marketr — Phase 4, Track R3: direct mail as a first-class nurture channel.
//
// INTEGRATION DESIGN (T1-native; this is the documented choice):
// - One MailCampaign per (sequence enrollment, mail step). The campaign holds
//   exactly one MailPiece for that step-run.
// - T1's lib/mail/service.ts owns ALL provider contact and money gates:
//     verifyAddresses → estimateCampaign → requestApproval (binds creativeHash
//     + pieceCount + maxSpendCents) → decideApproval (human) → executeCampaign
//     (re-verifies approval + hash + count + spend + per-piece consent, then
//     sends). This module never calls a provider directly and never bypasses
//     those gates.
// - R3 adaptations retained on top of T1's flow:
//     * Consent: T1's getMailConsent on the shared ContactConsent ledger,
//       channel "mail" (default-deny: only "opted_in" proceeds).
//     * Daily caps: workspace cap counts MailPiece sends + OutboundMessage
//       sends (shared counter across all channels); sequence cap counts
//       nurture mail campaigns created per sequence per day.
//     * Timing: date-based in-home window stored on the MailCampaign
//       (inHomeStart/inHomeEnd) plus the mailDate in audienceSource — never
//       quiet hours.
//     * Audit: T1's tables (campaign/piece/approval status transitions,
//       suppression reasons, costCents, sentAt) are the audit trail.
// - Metering: T1's service meters mail_verification (per piece) and
//   mail_piece (per send). This module does NOT meter, to avoid double-
//   charging the workspace.
// - Ad-hoc copy: nurture steps without a Studio creative get a MailCreative
//   row whose creativeHash = creativeHashFor(canonical rendered copy) — the
//   same binding primitive T2's finalized creatives use.

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  extractAddressFromLead,
  getMailConsent,
  verifyAddresses,
  requestApproval as requestMailApproval,
  executeCampaign,
  creativeHashFor,
} from "@/lib/mail/service";
import type { MailAddress } from "@/lib/mail/provider";
import { getMessagingSettings } from "./quiet-hours";
import { ConflictError, NotFoundError } from "@/lib/api/errors";

// ---------------------------------------------------------------------------
// Channel + scheduling primitives
// ---------------------------------------------------------------------------

export type MailChannel = "postcard" | "letter";

export function parseMailChannel(v: unknown): MailChannel | null {
  return v === "postcard" || v === "letter" ? v : null;
}

export function isMailChannel(v: unknown): v is MailChannel {
  return parseMailChannel(v) !== null;
}

export interface InHomeWindow {
  /** Date the piece is handed to the provider. */
  mailDate: Date;
  inHomeStart: Date;
  inHomeEnd: Date;
}

/**
 * Date-based in-home scheduling. mailDate is when the provider receives the
 * piece; in-home start/end = mailDate + USPS transit assumption [lo, hi]
 * days. Physical mail has days of latency — timing is date-based, never
 * quiet hours.
 */
export function estimateInHomeWindow(
  mailDate: Date,
  transitLoDays = 2,
  transitHiDays = 7,
): InHomeWindow {
  const day = 86_400_000;
  const lo = Math.max(0, transitLoDays);
  const hi = Math.max(lo, transitHiDays);
  return {
    mailDate,
    inHomeStart: new Date(mailDate.getTime() + lo * day),
    inHomeEnd: new Date(mailDate.getTime() + hi * day),
  };
}

/** {{merge}} rendering for mail copy (no HTML escaping — print copy). */
export function renderCopy(
  template: string,
  vars: Record<string, string | undefined>,
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    return v == null ? "" : v;
  });
}

/** Merge vars for a lead + its extracted address.
 * Short aliases (city/state/zip) are included alongside the address* names. */
export function mailMergeVars(
  lead: { name: string; company?: string | null; email?: string | null; phone?: string | null },
  addr: MailAddress,
): Record<string, string | undefined> {
  const firstName = lead.name.trim().split(/\s+/)[0] ?? "";
  return {
    name: lead.name,
    firstName,
    company: lead.company ?? undefined,
    email: lead.email ?? undefined,
    phone: lead.phone ?? undefined,
    addressLine1: addr.line1,
    addressLine2: addr.line2,
    addressCity: addr.city,
    addressState: addr.state,
    addressZip: addr.zip,
    city: addr.city,
    state: addr.state,
    zip: addr.zip,
  };
}

// Re-export T1's address extraction so callers share one implementation.
export { extractAddressFromLead };

async function mintQrSlug(): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const slug = `nrt-${randomBytes(5).toString("hex")}`;
    const hit = await prisma.mailPiece.findUnique({
      where: { qrSlug: slug },
      select: { id: true },
    });
    if (!hit) return slug;
  }
  throw new Error("Could not mint a unique mail QR slug");
}

// ---------------------------------------------------------------------------
// Queue: one nurture mail step-run → one MailCampaign + one MailPiece
// ---------------------------------------------------------------------------

export type NurtureMailKind = "sequence_step" | "manual" | "missed_call" | "speed_to_lead";

export interface QueueMailPieceInput {
  workspaceId: string;
  leadId: string;
  channel: MailChannel;
  copy: { headline?: string; body: string; cta?: string };
  /** T2 Studio creative id. When omitted, an ad-hoc creative is minted from
   *  the rendered copy and hash-bound the same way. */
  creativeId?: string;
  /** Days from queue time to mailDate (hand-to-provider). Default 1. */
  delayDays?: number;
  /** USPS transit assumption [min, max] days for the in-home window. Default [2, 7]. */
  inHomeTransitDays?: [number, number];
  sequenceId?: string;
  enrollmentId?: string;
  stepIndex?: number;
  kind?: NurtureMailKind;
  requestedBy?: string;
}

export interface QueuedMailPiece {
  suppressed: boolean;
  suppressionReason?: string;
  campaignId?: string;
  pieceId?: string;
  approvalId?: string;
  qrSlug?: string;
  verificationStatus?: string;
  estCostCents?: number;
  maxSpendCents?: number;
  inHome?: InHomeWindow;
}

/**
 * Suppression audit model (deliberate — mirrors T1 semantics):
 * - opt_out / no_consent / missing address: no T1 rows are created (T1's
 *   buildPieces skips these the same way). The reason is returned here and
 *   counted in NurtureMailDispatchResult; sequence advance logs it per step.
 * - quarantined (bad/undeliverable address): a full MailCampaign + suppressed
 *   MailPiece row ARE created and the campaign is cancelled — durable audit
 *   that an attempt was made and blocked.
 */
export async function queueMailPiece(input: QueueMailPieceInput): Promise<QueuedMailPiece> {
  const {
    workspaceId,
    leadId,
    channel,
    sequenceId,
    enrollmentId,
    stepIndex,
    kind = "sequence_step",
  } = input;
  const delayDays = Math.max(0, Math.floor(input.delayDays ?? 1));
  const [transitLo, transitHi] = input.inHomeTransitDays ?? [2, 7];

  const lead = await prisma.lead.findFirst({
    where: { id: leadId, workspaceId },
    select: { id: true, name: true, company: true, email: true, phone: true, customFields: true },
  });
  if (!lead) throw new NotFoundError("Lead not found in workspace");

  // 1. Consent (default-deny; T1 re-checks per piece at send time too).
  const consent = await getMailConsent(workspaceId, leadId);
  if (consent !== "opted_in") {
    return {
      suppressed: true,
      suppressionReason: consent === "opted_out" ? "opt_out" : "no_consent",
    };
  }

  // 2. Address (T1's extractor — nested "address" object or flat keys).
  const addr = extractAddressFromLead(lead);
  if (!addr) {
    return { suppressed: true, suppressionReason: "invalid_address" };
  }

  // 3. Timing + render. mailDate = queue time + delayDays (single application —
  //    the caller must NOT pre-add delayDays to "now").
  const now = new Date();
  const inHome = estimateInHomeWindow(
    new Date(now.getTime() + delayDays * 86_400_000),
    transitLo,
    transitHi,
  );
  const vars = mailMergeVars(lead, addr);
  const rendered = {
    headline: input.copy.headline ? renderCopy(input.copy.headline, vars) : undefined,
    body: renderCopy(input.copy.body, vars),
    cta: input.copy.cta ? renderCopy(input.copy.cta, vars) : undefined,
  };

  // 4. Creative: Studio creative when supplied (must be hash-finalized),
  //    otherwise an ad-hoc creative bound to the rendered copy bytes.
  let creativeId: string;
  if (input.creativeId) {
    const creative = await prisma.mailCreative.findFirst({
      where: { id: input.creativeId, workspaceId },
    });
    if (!creative) throw new NotFoundError("Studio creative not found in workspace");
    if (!creative.creativeHash) {
      throw new ConflictError("Studio creative is not finalized (no creative hash) — finalize it before use");
    }
    creativeId = creative.id;
  } else {
    const canonical = JSON.stringify({
      channel,
      headline: rendered.headline ?? "",
      body: rendered.body,
      cta: rendered.cta ?? "",
    });
    const creative = await prisma.mailCreative.create({
      data: {
        workspaceId,
        name: `Nurture ${channel} · ${lead.name}`.slice(0, 120),
        channelTemplate: "print",
        formatTrack: "addressed",
        size: channel === "postcard" ? "4x6" : "letter",
        source: "upload",
        creativeHash: creativeHashFor(canonical),
        status: "ready",
        createdBy: input.requestedBy ?? null,
      },
    });
    creativeId = creative.id;
  }

  // 5. Campaign (one per enrollment-step) + piece.
  const campaign = await prisma.mailCampaign.create({
    data: {
      workspaceId,
      name: `Nurture ${channel} · ${lead.name} · step ${(stepIndex ?? 0) + 1}`.slice(0, 160),
      creativeId,
      audienceSource: {
        kind: "nurture_step",
        nurtureKind: kind,
        channel,
        sequenceId: sequenceId ?? null,
        enrollmentId: enrollmentId ?? null,
        stepIndex: stepIndex ?? null,
        mailDate: inHome.mailDate.toISOString(),
      },
      pieceCount: 1,
      inHomeStart: inHome.inHomeStart,
      inHomeEnd: inHome.inHomeEnd,
      createdBy: input.requestedBy ?? null,
    },
  });
  const qrSlug = await mintQrSlug();
  const piece = await prisma.mailPiece.create({
    data: {
      campaignId: campaign.id,
      leadId: lead.id,
      addressSnapshot: addr as unknown as object,
      verificationStatus: "pending",
      qrSlug,
      status: "queued",
    },
  });

  // 6. Verification (T1 meters mail_verification per piece).
  await verifyAddresses(workspaceId, campaign.id);
  const verified = await prisma.mailPiece.findUniqueOrThrow({ where: { id: piece.id } });
  if (verified.verificationStatus === "quarantined") {
    await prisma.mailPiece.update({
      where: { id: piece.id },
      data: { status: "suppressed", suppressionReason: "invalid_address" },
    });
    await prisma.mailCampaign.update({
      where: { id: campaign.id },
      data: { status: "cancelled" },
    });
    return {
      suppressed: true,
      suppressionReason: "invalid_address",
      campaignId: campaign.id,
      pieceId: piece.id,
      verificationStatus: "quarantined",
    };
  }

  // 7. Workspace daily cap (shared counter: mail pieces + SMS/email/voice).
  const cap = await workspaceDailyCap(workspaceId);
  if ((await mailSendsToday(workspaceId)) >= cap) {
    await prisma.mailPiece.update({
      where: { id: piece.id },
      data: { status: "suppressed", suppressionReason: "cap_exceeded" },
    });
    await prisma.mailCampaign.update({
      where: { id: campaign.id },
      data: { status: "cancelled" },
    });
    return {
      suppressed: true,
      suppressionReason: "cap_exceeded",
      campaignId: campaign.id,
      pieceId: piece.id,
      verificationStatus: verified.verificationStatus,
    };
  }

  // 8. Approval (T1 binds creativeHash + pieceCount + maxSpendCents).
  const { approval, estimate } = await requestMailApproval(workspaceId, campaign.id, {
    requestedBy: input.requestedBy,
  });

  return {
    suppressed: false,
    campaignId: campaign.id,
    pieceId: piece.id,
    approvalId: approval.id,
    qrSlug,
    verificationStatus: verified.verificationStatus,
    estCostCents: estimate.subtotalCents,
    maxSpendCents: estimate.totalWithMarginCents,
    inHome,
  };
}

// ---------------------------------------------------------------------------
// Dispatch: due + approved nurture campaigns → T1 execute (the money gate)
// ---------------------------------------------------------------------------

export interface NurtureMailDispatchResult {
  attempted: number;
  sent: number;
  suppressed: number;
  failed: number;
  skippedCap: number;
  errors: Array<{ campaignId: string; error: string }>;
}

interface NurtureAudience {
  kind?: string;
  mailDate?: string;
  sequenceId?: string;
  enrollmentId?: string;
  stepIndex?: number;
  channel?: string;
}

function audienceOf(c: { audienceSource: unknown }): NurtureAudience {
  return (c.audienceSource ?? {}) as NurtureAudience;
}

export async function dispatchDueNurtureMail(
  workspaceId: string,
  now: Date = new Date(),
): Promise<NurtureMailDispatchResult> {
  const out: NurtureMailDispatchResult = {
    attempted: 0,
    sent: 0,
    suppressed: 0,
    failed: 0,
    skippedCap: 0,
    errors: [],
  };

  const campaigns = await prisma.mailCampaign.findMany({
    where: { workspaceId, status: "approved" },
    include: {
      approvals: {
        where: { status: "approved" },
        orderBy: { decidedAt: "desc" },
        take: 1,
      },
    },
  });

  for (const campaign of campaigns) {
    const aud = audienceOf(campaign);
    if (aud.kind !== "nurture_step") continue;
    if (!aud.mailDate || new Date(aud.mailDate).getTime() > now.getTime()) continue;
    if (campaign.approvals.length === 0) continue; // belt-and-braces; execute would refuse

    // Workspace daily cap (shared across channels), enforced atomically: the
    // count and the send run while holding a (workspace, UTC day) advisory
    // lock, so concurrent mail sweeps can't both see headroom and overshoot.
    // Its own key (not the SMS/email claim's), so a slow print-provider call
    // never stalls message claims. try-lock (not wait): a busy workspace-day
    // leaves this campaign approved for the next sweep instead of parking
    // pooled connections behind a provider call.
    const cap = await workspaceDailyCap(workspaceId);
    try {
      const outcome = await prisma.$transaction(
        async (tx) => {
          const lockKey = `mail-daily-cap:${workspaceId}:${now.toISOString().slice(0, 10)}`;
          const [row] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS locked`;
          if (!row?.locked) return "busy" as const;
          if ((await mailSendsToday(workspaceId, startOfUtcDay(now))) >= cap) return "cap" as const;
          // Sends commit on their own connections before the lock is released,
          // so the next holder's count sees them.
          return executeCampaign(workspaceId, campaign.id);
        },
        { maxWait: 15_000, timeout: 120_000 },
      );
      if (outcome === "busy") continue;
      if (outcome === "cap") {
        out.skippedCap += 1;
        continue;
      }
      out.attempted += 1;
      out.sent += outcome.sent;
      out.suppressed += outcome.suppressed + outcome.quarantinedSkipped;
      out.failed += outcome.failed;
    } catch (e) {
      out.attempted += 1;
      out.failed += 1;
      out.errors.push({
        campaignId: campaign.id,
        error: e instanceof Error ? e.message : "send failed",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Caps (shared counters across all channels)
// ---------------------------------------------------------------------------

async function workspaceDailyCap(workspaceId: string): Promise<number> {
  const settings = await getMessagingSettings(workspaceId);
  return settings.dailyCap;
}

/** Workspace sends today: mail pieces (sent/in_transit/delivered) + SMS/email/voice. */
export async function mailSendsToday(
  workspaceId: string,
  dayStart: Date = startOfUtcDay(new Date()),
): Promise<number> {
  const [mail, messages] = await Promise.all([
    prisma.mailPiece.count({
      where: {
        campaign: { workspaceId },
        sentAt: { gte: dayStart },
        status: { in: ["sent", "in_transit", "delivered"] },
      },
    }),
    prisma.outboundMessage.count({
      where: {
        workspaceId,
        createdAt: { gte: dayStart },
        status: { in: ["sent", "delivered"] },
      },
    }),
  ]);
  return mail + messages;
}

/** Sequence-level sends today for mail steps: nurture campaigns created today,
 *  excluding cancelled ones (quarantined addresses / cap blocks never mail and
 *  consume no spend, so they must not eat the cap). */
export async function sequenceMailSendsToday(
  workspaceId: string,
  sequenceId: string,
  dayStart: Date = startOfUtcDay(new Date()),
): Promise<number> {
  return prisma.mailCampaign.count({
    where: {
      workspaceId,
      createdAt: { gte: dayStart },
      status: { not: "cancelled" },
      audienceSource: { path: ["sequenceId"], equals: sequenceId },
    },
  });
}

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ---------------------------------------------------------------------------
// Ledger read for the /dashboard/direct-mail "Nurture mail" tab
// ---------------------------------------------------------------------------

export interface NurtureMailPieceRow {
  campaignId: string;
  campaignName: string;
  campaignStatus: string;
  channel: string | null;
  sequenceId: string | null;
  enrollmentId: string | null;
  stepIndex: number | null;
  mailDate: string | null;
  inHomeStart: string | null;
  inHomeEnd: string | null;
  pieceId: string;
  leadId: string | null;
  leadName: string | null;
  verificationStatus: string;
  qrSlug: string | null;
  pieceStatus: string;
  providerPieceId: string | null;
  costCents: number | null;
  sentAt: string | null;
  deliveredAt: string | null;
  suppressionReason: string | null;
  approvalStatus: string | null;
  maxSpendCents: number | null;
}

export async function getNurtureMailPieces(
  workspaceId: string,
  limit = 200,
): Promise<NurtureMailPieceRow[]> {
  const campaigns = await prisma.mailCampaign.findMany({
    where: {
      workspaceId,
      audienceSource: { path: ["kind"], equals: "nurture_step" },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      pieces: true,
      approvals: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  const leadIds = [
    ...new Set(
      campaigns.flatMap((c) => c.pieces.map((p) => p.leadId)).filter((id): id is string => !!id),
    ),
  ];
  const leads = leadIds.length
    ? await prisma.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, name: true } })
    : [];
  const names = new Map(leads.map((l) => [l.id, l.name]));

  return campaigns.flatMap((c) => {
    const aud = audienceOf(c);
    const approval = c.approvals[0] ?? null;
    return c.pieces.map((p) => ({
      campaignId: c.id,
      campaignName: c.name,
      campaignStatus: c.status,
      channel: aud.channel ?? null,
      sequenceId: aud.sequenceId ?? null,
      enrollmentId: aud.enrollmentId ?? null,
      stepIndex: typeof aud.stepIndex === "number" ? aud.stepIndex : null,
      mailDate: aud.mailDate ?? null,
      inHomeStart: c.inHomeStart?.toISOString() ?? null,
      inHomeEnd: c.inHomeEnd?.toISOString() ?? null,
      pieceId: p.id,
      leadId: p.leadId,
      leadName: p.leadId ? (names.get(p.leadId) ?? null) : null,
      verificationStatus: p.verificationStatus,
      qrSlug: p.qrSlug,
      pieceStatus: p.status,
      providerPieceId: p.providerPieceId,
      costCents: p.costCents,
      sentAt: p.sentAt?.toISOString() ?? null,
      deliveredAt: p.deliveredAt?.toISOString() ?? null,
      suppressionReason: p.suppressionReason,
      approvalStatus: approval?.status ?? null,
      maxSpendCents: approval?.maxSpendCents ?? null,
    }));
  });
}
