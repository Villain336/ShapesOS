// Marketr — R4 review-generation engine (acquisition loop).
//
// ReviewRequest lifecycle: sent → viewed → completed | expired.
// The public landing page (/r/review/<token>) drives viewed/completed;
// the token is the capability (unlisted random identifier), mirroring the
// physical-attribution vanity-slug model.
//
// Messaging goes through the dispatcher contract (currently
// ./dispatcher-shim.ts — repoint to "@/lib/messaging/dispatcher" once the
// messaging-core agent's real implementation lands). Every send is
// consent-gated: no SMS/email consent → SuppressedError, no ReviewRequest
// row minted, suppression surfaced to the caller.

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
// Messaging-core dispatcher (lib/messaging/dispatcher.ts). Contract:
// queueMessage returns the OutboundMessage — check status === "suppressed"
// (it never throws for suppression); requestApproval opens a manual approval.
import { queueMessage, requestApproval } from "@/lib/messaging/dispatcher";
import { getConsent } from "@/lib/messaging/consent";
import type { ReviewSiteConfig } from "@prisma/client";
import { qrPngDataUrl } from "@/lib/physical/qr";

export type ReviewChannel = "sms" | "email";

export class ReviewEngineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ReviewEngineError";
    this.code = code;
  }
}

/** Unlisted capability token for the public landing page. */
export function mintToken(): string {
  return randomBytes(24).toString("hex"); // 48 hex chars, 192 bits
}

export function reviewPageUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/r/review/${token}`;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_DELAY_DAYS = 1;
const REQUEST_TTL_DAYS = 30;

export async function getReviewConfig(workspaceId: string): Promise<ReviewSiteConfig[]> {
  return prisma.reviewSiteConfig.findMany({
    where: { workspaceId },
    orderBy: [{ site: "asc" }],
  });
}

export interface UpsertConfigInput {
  site: "google" | "facebook" | "yelp" | "custom";
  reviewUrl: string;
  delayDays?: number;
  enabled?: boolean;
}

export async function upsertReviewConfig(
  workspaceId: string,
  input: UpsertConfigInput,
): Promise<ReviewSiteConfig> {
  const delayDays = Math.max(0, Math.min(90, Math.floor(input.delayDays ?? DEFAULT_DELAY_DAYS)));
  let url: URL;
  try {
    url = new URL(input.reviewUrl.trim());
  } catch {
    throw new ReviewEngineError("invalid_url", "reviewUrl must be a valid absolute URL");
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new ReviewEngineError("invalid_url", "reviewUrl must use http(s)");
  }
  return prisma.reviewSiteConfig.upsert({
    where: { workspaceId_site: { workspaceId, site: input.site } },
    create: {
      workspaceId,
      site: input.site,
      reviewUrl: url.toString(),
      delayDays,
      enabled: input.enabled ?? true,
    },
    update: {
      reviewUrl: url.toString(),
      delayDays,
      enabled: input.enabled ?? true,
    },
  });
}

/** The config a send uses: enabled google first, else first enabled site. */
export async function activeReviewConfig(workspaceId: string): Promise<ReviewSiteConfig> {
  const configs = await prisma.reviewSiteConfig.findMany({
    where: { workspaceId, enabled: true },
    orderBy: [{ site: "asc" }],
  });
  const google = configs.find((c) => c.site === "google");
  const chosen = google ?? configs[0];
  if (!chosen) {
    throw new ReviewEngineError(
      "no_config",
      "No enabled review site configured — set a Google review URL in Reviews settings first.",
    );
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export interface SendReviewRequestOptions {
  workspaceId: string;
  leadId: string;
  channel: ReviewChannel;
  /** Public origin for the /r/review/<token> link (e.g. https://app.marketr.io). */
  origin: string;
  requestedBy?: string;
  /** Override the config's delayDays (0 = send now). */
  delayDays?: number;
}

function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

export async function sendReviewRequest(opts: SendReviewRequestOptions) {
  const { workspaceId, leadId, channel, origin, requestedBy } = opts;

  const lead = await prisma.lead.findFirst({ where: { id: leadId, workspaceId } });
  if (!lead) throw new ReviewEngineError("lead_not_found", "Lead not found in this workspace");

  // Consent guard: never mint a request we cannot deliver. The dispatcher
  // re-checks at queue time; this surfaces suppression before the token exists.
  // Only explicit "opted_in" passes (dispatcher suppresses everything else).
  const consent = await getConsent(workspaceId, leadId, channel);
  if (consent !== "opted_in") {
    throw new ReviewEngineError(
      "suppressed",
      channel === "sms"
        ? `Cannot send: no SMS consent on file for ${lead.name} (consent: ${consent}).`
        : `Cannot send: no email consent on file for ${lead.name} (consent: ${consent}).`,
    );
  }
  if (channel === "sms" && !lead.phone) {
    throw new ReviewEngineError("no_phone", `${lead.name} has no phone number on file.`);
  }
  if (channel === "email" && !lead.email) {
    throw new ReviewEngineError("no_email", `${lead.name} has no email address on file.`);
  }

  const config = await activeReviewConfig(workspaceId);
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  const businessName = workspace?.name?.trim() || "us";

  const token = mintToken();
  const pageUrl = reviewPageUrl(origin, token);
  const delayDays = opts.delayDays ?? config.delayDays;
  const scheduledFor = new Date(Date.now() + Math.max(0, delayDays) * 86_400_000);

  const reviewRequest = await prisma.reviewRequest.create({
    data: {
      workspaceId,
      leadId,
      token,
      channel,
      status: "sent",
      reviewUrl: config.reviewUrl,
      sentAt: new Date(),
      expiresAt: new Date(Date.now() + REQUEST_TTL_DAYS * 86_400_000),
    },
  });

  const body =
    channel === "sms"
      ? `Hi ${firstNameOf(lead.name)} — thanks for choosing ${businessName}! If you had a great experience, we'd love a quick review: ${pageUrl}`
      : undefined;
  const emailBody = `Hi ${firstNameOf(lead.name)},\n\nThanks for choosing ${businessName}! If you had a great experience, we'd really appreciate a quick review — it takes about a minute:\n\n${pageUrl}\n\nThanks so much,\n${businessName}`;
  const subject = channel === "email" ? `How was your experience with ${businessName}?` : undefined;

  // Manual approval (Phase 3 ships manual-only): the approval authorizes the
  // send; the dispatcher's approval→dispatch step (messaging-core) delivers it.
  const approval = await requestApproval({
    workspaceId,
    kind: "review_request",
    payload: {
      reviewRequestId: reviewRequest.id,
      leadId,
      leadName: lead.name,
      channel,
      reviewUrl: config.reviewUrl,
      pageUrl,
      body: channel === "sms" ? body : emailBody,
      subject,
    },
    requestedBy,
  });

  let message;
  message = await queueMessage({
    workspaceId,
    leadId,
    channel,
    kind: "review_request",
    subject,
    body: channel === "sms" ? (body as string) : emailBody,
    approvalId: approval.id,
    scheduledFor,
    requestedBy,
  });
  if (message.status === "suppressed") {
    // Consent was revoked (or cap hit) between the pre-check and the queue
    // call: the dispatcher records the suppressed row itself, so roll the
    // request back and cancel the approval — the funnel never shows an
    // unsendable "sent".
    await prisma.reviewRequest.delete({ where: { id: reviewRequest.id } });
    await prisma.approvalItem.update({
      where: { id: approval.id },
      data: { status: "cancelled", note: `Suppressed: ${message.suppressionReason}` },
    });
    throw new ReviewEngineError(
      "suppressed",
      `Suppressed by dispatcher: ${message.suppressionReason}`,
    );
  }

  await prisma.reviewRequest.update({
    where: { id: reviewRequest.id },
    data: { messageId: message.id },
  });

  return {
    reviewRequest: { ...reviewRequest, messageId: message.id },
    approval,
    message,
    pageUrl,
  };
}

/**
 * Trigger helper: picks the first consented channel (sms → email), honors the
 * active config's delayDays via scheduledFor. Returns null when the lead has
 * no usable channel (suppression surfaced in `reason`).
 */
export async function triggerReviewRequest(
  workspaceId: string,
  leadId: string,
  opts?: { origin: string; requestedBy?: string },
): Promise<
  | { sent: true; channel: ReviewChannel; reviewRequestId: string; pageUrl: string }
  | { sent: false; reason: string }
> {
  const channels: ReviewChannel[] = ["sms", "email"];
  for (const channel of channels) {
    if ((await getConsent(workspaceId, leadId, channel)) !== "opted_in") continue;
    try {
      const res = await sendReviewRequest({
        workspaceId,
        leadId,
        channel,
        origin: opts?.origin ?? "",
        requestedBy: opts?.requestedBy,
      });
      return {
        sent: true,
        channel,
        reviewRequestId: res.reviewRequest.id,
        pageUrl: res.pageUrl,
      };
    } catch (e) {
      if (e instanceof ReviewEngineError && (e.code === "suppressed" || e.code === "no_phone" || e.code === "no_email")) {
        continue; // try the next channel
      }
      throw e;
    }
  }
  return { sent: false, reason: "no consented channel with contact details" };
}

// ---------------------------------------------------------------------------
// Funnel + listing
// ---------------------------------------------------------------------------

export interface FunnelStats {
  sent: number;
  viewed: number;
  completed: number;
  expired: number;
  viewRate: number; // viewed / sent
  completionRate: number; // completed / sent
  completedOfViewed: number; // completed / viewed
}

export async function funnelStats(workspaceId: string): Promise<FunnelStats> {
  const [sent, viewed, completed, expired] = await Promise.all([
    prisma.reviewRequest.count({ where: { workspaceId, status: "sent" } }),
    prisma.reviewRequest.count({ where: { workspaceId, status: "viewed" } }),
    prisma.reviewRequest.count({ where: { workspaceId, status: "completed" } }),
    prisma.reviewRequest.count({ where: { workspaceId, status: "expired" } }),
  ]);
  // "sent" here means the request exists (statuses sent+viewed+completed+expired
  // all started as sent). Use total for rate denominators.
  const total = sent + viewed + completed + expired;
  const pct = (n: number) => (total === 0 ? 0 : Math.round((n / total) * 1000) / 10);
  return {
    sent: total,
    viewed,
    completed,
    expired,
    viewRate: pct(viewed + completed),
    completionRate: pct(completed),
    completedOfViewed: viewed + completed === 0 ? 0 : Math.round((completed / (viewed + completed)) * 1000) / 10,
  };
}

export async function listReviewRequests(
  workspaceId: string,
  opts?: { status?: string; limit?: number },
) {
  return prisma.reviewRequest.findMany({
    where: { workspaceId, ...(opts?.status ? { status: opts.status } : {}) },
    include: { lead: { select: { id: true, name: true, email: true, phone: true } } },
    orderBy: { sentAt: "desc" },
    take: Math.min(opts?.limit ?? 100, 500),
  });
}

export async function markRequestCompleted(
  reviewRequestId: string,
  workspaceId: string,
  opts?: { manual?: boolean },
) {
  const req = await prisma.reviewRequest.findFirst({
    where: { id: reviewRequestId, workspaceId },
  });
  if (!req) throw new ReviewEngineError("not_found", "Review request not found");
  if (req.status === "completed") return req;
  return prisma.reviewRequest.update({
    where: { id: req.id },
    data: {
      status: "completed",
      viewedAt: req.viewedAt ?? new Date(),
      completedAt: new Date(),
    },
  });
}

// ---------------------------------------------------------------------------
// Public landing-page transitions (token capability)
// ---------------------------------------------------------------------------

export async function getRequestByToken(token: string) {
  const req = await prisma.reviewRequest.findUnique({
    where: { token },
    include: {
      workspace: { select: { id: true, name: true, whiteLabelBrandColor: true } },
    },
  });
  if (!req) return null;
  if (req.expiresAt && req.expiresAt < new Date() && req.status !== "completed") {
    await prisma.reviewRequest.update({
      where: { id: req.id },
      data: { status: "expired" },
    });
    return { ...req, status: "expired" as const };
  }
  return req;
}

export async function markViewedByToken(token: string) {
  const req = await getRequestByToken(token);
  if (!req || req.status === "expired") return req;
  if (req.status === "sent") {
    return prisma.reviewRequest.update({
      where: { id: req.id },
      data: { status: "viewed", viewedAt: new Date() },
    });
  }
  return req;
}

export async function markCompletedByToken(token: string) {
  const req = await getRequestByToken(token);
  if (!req || req.status === "expired" || req.status === "completed") return req;
  return prisma.reviewRequest.update({
    where: { id: req.id },
    data: {
      status: "completed",
      viewedAt: req.viewedAt ?? new Date(),
      completedAt: new Date(),
    },
  });
}

/** Printable QR (PNG data URL) for a request's public landing page. */
export async function requestQrDataUrl(origin: string, token: string): Promise<string> {
  return qrPngDataUrl(reviewPageUrl(origin, token), 1);
}

/** Brand tone for AI copy: workspace's default BrandKit tone, if present. */
export async function brandToneFor(workspaceId: string): Promise<string | null> {
  const kit = await prisma.brandKit.findFirst({
    where: { workspaceId, isDefault: true },
    select: { tone: true, name: true },
  });
  return kit?.tone?.trim() ? `${kit.name}: ${kit.tone.trim()}` : null;
}
