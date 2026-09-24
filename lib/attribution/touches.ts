// Marketr — Revenue attribution (C2): touch capture.
//
// A touch is one marketing contact with a lead: a visit carrying UTM params,
// a form submission, a tracked call, a manual entry. Touches are the raw
// material; lib/attribution/models.ts turns them into channel credit.
//
// Capture contract: every lead capture path records exactly one `first` touch
// at creation (channel derived from the lead source + UTM params when
// present), so "leads by channel" is meaningful even without UTMs. Later
// touches (visits, calls, manual) are appended with logTouch().

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** UTM fields accepted on the capture paths (query params or CSV columns). */
export interface UtmInput {
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_term?: string | null;
  utm_content?: string | null;
}

export function hasUtm(u: UtmInput | null | undefined): boolean {
  if (!u) return false;
  return Boolean(
    (u.utm_source ?? "").trim() ||
      (u.utm_medium ?? "").trim() ||
      (u.utm_campaign ?? "").trim() ||
      (u.utm_term ?? "").trim() ||
      (u.utm_content ?? "").trim(),
  );
}

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

/**
 * Normalize a lead source + UTM pair into the channel vocabulary used by the
 * dashboard. Rules (deterministic, documented so agencies can quote them):
 *
 *   paid mediums (cpc/ppc/cpm/cpa/paid):
 *     google|bing|duckduckgo → "paid_search", anything else → "paid_ads"
 *   medium email|sms|qr (or matching source) → "email" | "sms" | "qr_code"
 *   paid social mediums → "paid_social"
 *   known sources → organic_search / social_organic / email / direct / referral
 *   unknown source → sanitized source string ("my-crm" → "my_crm")
 *   no UTM at all → the lead's capture source:
 *     website_form→website, phone→phone, referral→referral, import→import,
 *     ad→paid_ads, ooh→ooh, direct_mail→direct_mail, other→other
 */
export function channelFor(leadSource: string, utm: UtmInput | null | undefined): string {
  const src = norm(utm?.utm_source);
  const med = norm(utm?.utm_medium);

  if (med === "cpc" || med === "ppc" || med === "cpm" || med === "cpa" || med === "paid") {
    if (src === "google" || src === "bing" || src === "duckduckgo") return "paid_search";
    return "paid_ads";
  }
  if (med === "email" || src === "email" || src === "newsletter") return "email";
  if (med === "sms" || src === "sms") return "sms";
  if (med === "qr" || src === "qr" || src === "qr_code") return "qr_code";
  if (med === "promo" || src === "promo" || src === "promo_code") return "promo_code";
  if (med === "social-paid" || med === "paid_social") return "paid_social";

  const ALIASES: Record<string, string> = {
    google: "organic_search",
    bing: "organic_search",
    duckduckgo: "organic_search",
    yahoo: "organic_search",
    facebook: "social_organic",
    instagram: "social_organic",
    linkedin: "social_organic",
    twitter: "social_organic",
    x: "social_organic",
    tiktok: "social_organic",
    youtube: "social_organic",
    direct: "direct",
    referral: "referral",
    organic: "organic_search",
  };
  if (src) {
    if (ALIASES[src]) return ALIASES[src];
    const cleaned = src.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
    return cleaned || "other";
  }

  const SOURCE_CHANNEL: Record<string, string> = {
    website_form: "website",
    phone: "phone",
    referral: "referral",
    import: "import",
    ad: "paid_ads",
    ooh: "ooh",
    direct_mail: "direct_mail",
    booking: "booking",
    promo_code: "promo_code",
    qr_scan: "qr_code",
    other: "other",
  };
  return SOURCE_CHANNEL[leadSource] ?? "other";
}

export type TouchType = "first" | "visit" | "form" | "call" | "manual";

/** Truncate to the hour — the dedup window for identical touch submissions. */
function hourBucket(d: Date): string {
  const h = new Date(d);
  h.setUTCMinutes(0, 0, 0);
  return h.toISOString();
}

/**
 * sha256 of the touch's natural key. A double-submitted form, a retried
 * webhook, or a re-imported CSV row collapses to one touch; the UNIQUE
 * (leadId, dedupHash) constraint is the race-safe backstop (P2002 → return
 * the existing touch).
 */
export function touchDedupHash(
  leadId: string,
  parts: {
    channel: string;
    source?: string | null;
    medium?: string | null;
    campaign?: string | null;
    contentId?: string | null;
    touchType: TouchType;
    occurredAt: Date;
  },
): string {
  const key = [
    leadId,
    parts.channel,
    parts.source ?? "",
    parts.medium ?? "",
    parts.campaign ?? "",
    parts.contentId ?? "",
    parts.touchType,
    hourBucket(parts.occurredAt),
  ].join("|");
  return createHash("sha256").update(key).digest("hex");
}

export interface LogTouchInput {
  workspaceId: string;
  leadId: string;
  channel: string;
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  contentId?: string | null;
  touchType?: TouchType;
  occurredAt?: Date;
  meta?: Record<string, unknown>;
}

/**
 * Record one touch. Tenant-safe: the lead must belong to the workspace
 * (throws otherwise). Idempotent within the hour-dedup window.
 */
export async function logTouch(input: LogTouchInput) {
  const lead = await prisma.lead.findFirst({
    where: { id: input.leadId, workspaceId: input.workspaceId },
    select: { id: true },
  });
  if (!lead) throw new Error("Lead not found in workspace");
  if (input.contentId) {
    // C2 tenant validation: a contentId must reference a ContentItem whose
    // project belongs to this workspace — never a foreign workspace's page.
    const item = await prisma.contentItem.findFirst({
      where: { id: input.contentId, project: { workspaceId: input.workspaceId } },
      select: { id: true },
    });
    if (!item) throw new Error("Content not found in workspace");
  }

  const channel = input.channel.trim().toLowerCase().slice(0, 64) || "other";
  const touchType: TouchType = input.touchType ?? "visit";
  const occurredAt = input.occurredAt ?? new Date();
  const dedupHash = touchDedupHash(input.leadId, {
    channel,
    source: input.source,
    medium: input.medium,
    campaign: input.campaign,
    contentId: input.contentId,
    touchType,
    occurredAt,
  });

  const data = {
    workspaceId: input.workspaceId,
    leadId: input.leadId,
    channel,
    source: input.source?.trim() || null,
    medium: input.medium?.trim() || null,
    campaign: input.campaign?.trim() || null,
    contentId: input.contentId?.trim() || null,
    touchType,
    occurredAt,
    dedupHash,
    meta: (input.meta ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
  };
  try {
    return await prisma.attributionTouch.create({ data });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Lost the race (or a retry): return the existing touch.
      return prisma.attributionTouch.findFirst({
        where: { leadId: input.leadId, dedupHash },
      });
    }
    throw e;
  }
}

/**
 * Record the creation touch for a lead captured with optional UTMs.
 * `campaignFallback` (e.g. the capture form's name) is used when no
 * utm_campaign is present, so the campaigns table stays useful.
 */
export async function recordCaptureTouch(opts: {
  workspaceId: string;
  leadId: string;
  leadSource: string;
  utm?: UtmInput | null;
  contentId?: string | null;
  campaignFallback?: string | null;
}) {
  const utm = opts.utm ?? {};
  return logTouch({
    workspaceId: opts.workspaceId,
    leadId: opts.leadId,
    channel: channelFor(opts.leadSource, utm),
    source: utm.utm_source?.trim() || null,
    medium: utm.utm_medium?.trim() || null,
    campaign: utm.utm_campaign?.trim() || opts.campaignFallback?.trim() || null,
    contentId: opts.contentId ?? null,
    touchType: "first",
    meta: {
      ...(utm.utm_term?.trim() ? { utm_term: utm.utm_term.trim() } : {}),
      ...(utm.utm_content?.trim() ? { utm_content: utm.utm_content.trim() } : {}),
    },
  });
}
