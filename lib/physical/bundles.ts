// Marketr — Physical attribution kit (P2): bundle lifecycle, scans,
// promo redemption, and per-bundle stats.
//
// A bundle ties four artifacts to one campaign key:
//   1. tracking phone number (CallNumber, provisioned via the R5 provider
//      abstraction — fake telephony until TWILIO_* creds exist),
//   2. QR code (generated on demand from the vanity URL; nothing at rest),
//   3. vanity URL slug — globally unique; /r/<slug> logs a scan then 302s
//      to the destination with UTM params merged in,
//   4. promo code (WAVE-XXXXXX, redeemable on lead forms / redeem endpoint).
//
// Capability model (honest version): the slug and the promo code are
// unlisted random identifiers, not cryptographic secrets. There is no
// directory or enumeration endpoint; guessing is the only discovery path.
// Slugs carry 40 bits of randomness (plus an optional human-readable
// prefix), promo codes 30 bits (6 chars × 32-symbol alphabet) behind a
// per-code+IP rate limit — enough that blind guessing is infeasible, but
// neither is a substitute for real access control. Nothing behind /r/<slug>
// is confidential (it issues a redirect); the redeem endpoint only ever
// creates a lead and logs touches.
//
// Attribution credit flows through AttributionTouch rows carrying the
// bundle's campaignName, so first/last/linear models credit them with no
// model changes. The touch channels are:
//   - "qr_code"  (identified vanity-URL scans: medium=qr / source=vanity-url,
//                 or a lead's capture UTM medium=qr)
//   - "promo_code" (redemptions and promoCode-bearing lead captures)
//   - "phone"    (calls to the bundle's tracking number — R5 path, with the
//                 bundle campaign as the campaign fallback)
//
// Scans are anonymous events (BundleScan, deduped per bundle+ip+day). A scan
// only becomes an AttributionTouch when the scanner is identifiable — a
// ?lead=<id> param matching a workspace lead — because touches require a
// lead. Redemption is the identified conversion: it always creates or
// matches a lead and logs the promo_code touch.

import { createHash, randomBytes } from "node:crypto";
import { Prisma, type AttributionBundle } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/calls/provider";
import { logTouch } from "@/lib/attribution/touches";
import { getAttributionReport, type ReportWindow } from "@/lib/attribution/report";
import { ATTRIBUTION_MODELS, type AttributionModel } from "@/lib/attribution/models";
import { createLeadRecord } from "@/lib/crm/leads";
import { normalizePhone } from "@/lib/calls/inbound";

export type BundleWithNumber = AttributionBundle & {
  number: { id: string; e164: string; status: string } | null;
};

// ---------------------------------------------------------------------------
// Slug + promo-code minting
// ---------------------------------------------------------------------------

const PROMO_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no ambiguous chars

export function mintPromoCode(): string {
  const bytes = randomBytes(6);
  let body = "";
  for (const b of bytes) body += PROMO_ALPHABET[b % PROMO_ALPHABET.length];
  return `WAVE-${body}`;
}

export function slugifyName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 40)
      .replace(/^-+|-+$/g, "") || "bundle"
  );
}

function randomSuffix(bytes = 5): string {
  // 2 hex chars per byte: 10 chars / 40 bits. Slugs are unlisted, not
  // secret — this is anti-enumeration entropy, not a cryptographic key.
  return randomBytes(bytes).toString("hex");
}

/** Globally unique slug: /r/<slug> resolves with no workspace key. */
async function uniqueSlug(wanted: string): Promise<string> {
  let candidate = wanted;
  for (let i = 0; i < 8; i++) {
    const hit = await prisma.attributionBundle.findFirst({
      where: { vanitySlug: candidate },
      select: { id: true },
    });
    if (!hit) return candidate;
    candidate = `${wanted}-${randomSuffix()}`;
  }
  throw new Error("Could not mint a unique vanity slug");
}

async function uniquePromoCode(): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const code = mintPromoCode();
    const hit = await prisma.attributionBundle.findFirst({
      where: { promoCode: code },
      select: { id: true },
    });
    if (!hit) return code;
  }
  throw new Error("Could not mint a unique promo code");
}

// ---------------------------------------------------------------------------
// Bundle creation (one click → all four artifacts)
// ---------------------------------------------------------------------------

export interface CreateBundleInput {
  workspaceId: string;
  name: string;
  campaignName: string;
  destinationUrl: string;
  vanitySlug?: string;
  areaCode?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
}

export async function createBundle(input: CreateBundleInput): Promise<BundleWithNumber> {
  const url = new URL(input.destinationUrl); // throws on invalid
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Destination URL must be http(s)");
  }
  const trimmed = {
    name: input.name.trim(),
    campaignName: input.campaignName.trim(),
    destinationUrl: input.destinationUrl.trim(),
    utmSource: (input.utmSource ?? "physical").trim().slice(0, 64),
    utmMedium: (input.utmMedium ?? "qr").trim().slice(0, 64),
    utmCampaign: (input.utmCampaign ?? input.campaignName).trim().slice(0, 160) || null,
    areaCode: input.areaCode?.trim() || undefined,
  };
  const slugBase = (input.vanitySlug ?? "").trim()
    ? slugifyName(input.vanitySlug!.trim())
    : `${slugifyName(trimmed.name)}-${randomSuffix()}`;

  // Provision the tracking number through the R5 provider layer. The CallNumber
  // row carries the bundle campaign as its campaign label, so inbound calls
  // to it attribute to the same campaign as the QR/promo touches.
  //
  // The CallNumber row and the bundle row are created in ONE database
  // transaction: if the bundle insert fails (slug/promo race, validation),
  // the number row rolls back with it — no orphaned numbers in OUR database.
  // The provider purchase itself is external and cannot be rolled back: with
  // a real Twilio account, a DB failure after a successful purchase leaves an
  // unrecorded number in the Twilio console (reclaim it there). The fake
  // provider's counter resets per process, so a restarted process can re-mint
  // an e164 that already exists: retry purchase on e164 P2002.
  const provider = getProvider();
  for (let attempt = 0; attempt < 8; attempt++) {
    const slug = await uniqueSlug(slugBase);
    const promoCode = await uniquePromoCode();
    let purchased: { e164: string; providerSid: string };
    try {
      purchased = await provider.purchaseNumber({
        areaCode: trimmed.areaCode,
        friendlyName: `bundle:${trimmed.name}`.slice(0, 64),
        campaign: trimmed.campaignName,
      });
    } catch (e) {
      throw new Error(`Number provisioning failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
    try {
      const bundle = await prisma.$transaction(async (tx) => {
        const number = await tx.callNumber.create({
          data: {
            workspaceId: input.workspaceId,
            e164: purchased.e164,
            provider: provider.name,
            providerSid: purchased.providerSid,
            friendlyName: `bundle:${trimmed.name}`.slice(0, 64),
            campaign: trimmed.campaignName,
            status: "active",
          },
        });
        return tx.attributionBundle.create({
          data: {
            workspaceId: input.workspaceId,
            name: trimmed.name,
            campaignName: trimmed.campaignName,
            destinationUrl: trimmed.destinationUrl,
            vanitySlug: slug,
            utmSource: trimmed.utmSource,
            utmMedium: trimmed.utmMedium,
            utmCampaign: trimmed.utmCampaign,
            promoCode,
            numberId: number.id,
            status: "active",
          },
          include: { number: { select: { id: true, e164: true, status: true } } },
        });
      });
      return bundle;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        // Unique-race backstop: re-mint and retry. The transaction rolled
        // back, so no orphaned CallNumber row survives.
        const target = JSON.stringify(e.meta?.target ?? "");
        if (/vanity_slug|promo_code|e164/.test(target)) continue;
      }
      throw e;
    }
  }
  throw new Error("Number provisioning failed: could not mint a free number after retries");
}

export async function listBundles(workspaceId: string): Promise<BundleWithNumber[]> {
  return prisma.attributionBundle.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    include: { number: { select: { id: true, e164: true, status: true } } },
  });
}

export async function getBundle(workspaceId: string, id: string): Promise<BundleWithNumber | null> {
  return prisma.attributionBundle.findFirst({
    where: { id, workspaceId },
    include: { number: { select: { id: true, e164: true, status: true } } },
  });
}

export async function setBundleStatus(
  workspaceId: string,
  id: string,
  status: "active" | "disabled",
): Promise<BundleWithNumber> {
  const existing = await getBundle(workspaceId, id);
  if (!existing) throw new Error("Bundle not found");
  return prisma.attributionBundle.update({
    where: { id },
    data: { status },
    include: { number: { select: { id: true, e164: true, status: true } } },
  });
}

/** "Regenerate QR" cycles the render preset. The vanity URL (QR content) never
 * changes, so printed codes keep working. */
export async function regenerateQrStyle(
  workspaceId: string,
  id: string,
): Promise<BundleWithNumber> {
  const existing = await getBundle(workspaceId, id);
  if (!existing) throw new Error("Bundle not found");
  return prisma.attributionBundle.update({
    where: { id },
    data: { qrStyle: existing.qrStyle + 1 },
    include: { number: { select: { id: true, e164: true, status: true } } },
  });
}

export function vanityUrlFor(bundle: { vanitySlug: string }, origin: string): string {
  return `${origin.replace(/\/$/, "")}/r/${bundle.vanitySlug}`;
}

// ---------------------------------------------------------------------------
// Public origin for customer-facing links (vanity URLs baked into QR codes,
// DNI snippets). The standalone server does not trust the Host header
// (trustHostHeader: false), so the request URL carries the bind address
// (e.g. http://0.0.0.0:3000) — useless on a printed mailer. An explicit
// APP_PUBLIC_URL always wins; otherwise fall back to the request origin.
// ---------------------------------------------------------------------------

export function publicOrigin(req: Request): string {
  const configured = (process.env.APP_PUBLIC_URL ?? "").trim().replace(/\/$/, "");
  if (configured) return configured;
  return new URL(req.url).origin;
}

// ---------------------------------------------------------------------------
// Vanity-URL redirect (public). The slug is the capability.
// ---------------------------------------------------------------------------

export interface VanityRedirectResult {
  status: 302 | 404 | 410;
  location?: string;
  /** True when this hit created a new scan row (first scan today for IP). */
  scanLogged: boolean;
  /** True when an identified scanner produced an attribution touch. */
  touchLogged: boolean;
}

function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function ipHash(ip: string): string {
  return createHash("sha256").update(ip.trim().toLowerCase()).digest("hex");
}

/** Merge UTMs into the destination. Precedence (highest first):
 *   1. query params on the scanned /r URL (placement passthrough — the
 *      printed piece's own tagging wins; the internal `lead` param excluded),
 *   2. query params already on the destination URL (the marketer's canonical
 *      tagging),
 *   3. the bundle's UTM defaults.
 */
export function mergeUtms(
  destinationUrl: string,
  bundle: Pick<AttributionBundle, "utmSource" | "utmMedium" | "utmCampaign">,
  scanQuery?: URLSearchParams,
): string {
  const u = new URL(destinationUrl);
  if (!u.searchParams.has("utm_source")) u.searchParams.set("utm_source", bundle.utmSource);
  if (!u.searchParams.has("utm_medium")) u.searchParams.set("utm_medium", bundle.utmMedium);
  if (bundle.utmCampaign && !u.searchParams.has("utm_campaign")) {
    u.searchParams.set("utm_campaign", bundle.utmCampaign);
  }
  if (scanQuery) {
    for (const [k, v] of scanQuery) {
      if (k === "lead") continue;
      u.searchParams.set(k, v);
    }
  }
  return u.toString();
}

export async function handleVanityRedirect(opts: {
  slug: string;
  ip: string;
  query: URLSearchParams;
  userAgent?: string | null;
  referer?: string | null;
}): Promise<VanityRedirectResult> {
  // Globally unique slug → deterministic lookup (no workspace key on the
  // public route). findUnique, not findFirst: exactly one bundle can own it.
  const bundle = await prisma.attributionBundle.findUnique({
    where: { vanitySlug: opts.slug },
    select: {
      id: true,
      workspaceId: true,
      status: true,
      destinationUrl: true,
      utmSource: true,
      utmMedium: true,
      utmCampaign: true,
      campaignName: true,
    },
  });
  if (!bundle) return { status: 404, scanLogged: false, touchLogged: false };
  if (bundle.status !== "active") return { status: 410, scanLogged: false, touchLogged: false };

  // Anonymous scan event, deduped per (bundle, ip, UTC day). The UNIQUE
  // constraint is the race backstop; P2002 means "already counted today".
  let scanLogged = false;
  try {
    await prisma.bundleScan.create({
      data: {
        bundleId: bundle.id,
        ipHash: ipHash(opts.ip),
        day: dayKey(),
        userAgent: opts.userAgent?.slice(0, 512) ?? null,
        referer: opts.referer?.slice(0, 1024) ?? null,
      },
    });
    scanLogged = true;
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
  }

  // Identified scan: a ?lead=<id> param matching a lead in the bundle's
  // workspace logs a qr_code touch BEFORE the redirect. Anonymous scans stay
  // events-only — touches require a lead.
  let touchLogged = false;
  const leadId = opts.query.get("lead")?.trim();
  if (leadId) {
    try {
      await logTouch({
        workspaceId: bundle.workspaceId,
        leadId,
        channel: "qr_code",
        source: "vanity-url",
        medium: "qr",
        campaign: bundle.campaignName,
        touchType: "visit",
        meta: { slug: opts.slug },
      });
      touchLogged = true;
    } catch {
      // Unknown/forbidden lead: still redirect, just no touch.
    }
  }

  return {
    status: 302,
    location: mergeUtms(bundle.destinationUrl, bundle, opts.query),
    scanLogged,
    touchLogged,
  };
}

// ---------------------------------------------------------------------------
// Promo redemption
// ---------------------------------------------------------------------------

export async function findActiveBundleByCode(code: string): Promise<BundleWithNumber | null> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;
  return prisma.attributionBundle.findFirst({
    where: { promoCode: normalized, status: "active" },
    include: { number: { select: { id: true, e164: true, status: true } } },
  });
}

/**
 * Attach a promo code to an existing lead (lead-form path). Invalid or
 * disabled codes are silently ignored — a bad promo must never fail lead
 * creation. Returns the bundle when the code was valid.
 */
export async function applyPromoCodeToLead(
  workspaceId: string,
  leadId: string,
  code: string,
): Promise<BundleWithNumber | null> {
  const bundle = await prisma.attributionBundle.findFirst({
    where: { promoCode: code.trim().toUpperCase(), workspaceId, status: "active" },
    include: { number: { select: { id: true, e164: true, status: true } } },
  });
  if (!bundle) return null;
  await logTouch({
    workspaceId,
    leadId,
    channel: "promo_code",
    source: "promo",
    medium: "promo",
    campaign: bundle.campaignName,
    touchType: "form",
    meta: { promoCode: bundle.promoCode, bundleId: bundle.id },
  });
  try {
    await prisma.bundleRedemption.create({
      data: { bundleId: bundle.id, leadId, code: bundle.promoCode },
    });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
  }
  return bundle;
}

async function matchLeadByContact(
  workspaceId: string,
  email?: string,
  phone?: string,
): Promise<string | null> {
  const em = email?.trim().toLowerCase();
  if (em) {
    const hit = await prisma.lead.findFirst({
      where: { workspaceId, email: em },
      select: { id: true },
      orderBy: { updatedAt: "desc" },
    });
    if (hit) return hit.id;
  }
  const key = normalizePhone(phone);
  if (key) {
    const leads = await prisma.lead.findMany({
      where: { workspaceId, phone: { not: null } },
      select: { id: true, phone: true },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
    const hit = leads.find((l) => normalizePhone(l.phone) === key);
    if (hit) return hit.id;
  }
  return null;
}

export interface RedeemInput {
  code: string;
  email?: string;
  phone?: string;
  name?: string;
  ip: string;
}

export interface RedeemResult {
  leadId: string;
  created: boolean;
  bundleId: string;
  campaignName: string;
}

/**
 * Public promo redemption (token-less; the code is the capability, scoped to
 * its bundle's workspace). Matches an existing lead by email/phone, or
 * creates one, then logs the promo_code touch + redemption row.
 */
export async function redeemPromoCode(input: RedeemInput): Promise<RedeemResult> {
  const bundle = await findActiveBundleByCode(input.code);
  if (!bundle) throw new Error("Invalid or expired promo code");
  if (!input.email?.trim() && !input.phone?.trim()) {
    throw new Error("Email or phone is required to redeem");
  }

  let leadId = await matchLeadByContact(bundle.workspaceId, input.email, input.phone);
  let created = false;
  if (!leadId) {
    const pipeline = await prisma.pipeline.findFirst({
      where: { workspaceId: bundle.workspaceId },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!pipeline) throw new Error("No pipeline in workspace");
    const res = await createLeadRecord(bundle.workspaceId, "promo-redeem", {
      pipelineId: pipeline.id,
      name: input.name?.trim() || "Promo redemption",
      email: input.email?.trim() || undefined,
      phone: input.phone?.trim() || undefined,
      source: "other",
      sourceDetail: `promo:${bundle.promoCode}`,
    });
    if (!res.ok) throw new Error("Could not create lead");
    leadId = res.lead.id;
    created = true;
  }

  await applyPromoCodeToLead(bundle.workspaceId, leadId, bundle.promoCode);
  return { leadId, created, bundleId: bundle.id, campaignName: bundle.campaignName };
}

// ---------------------------------------------------------------------------
// Per-code+IP rate limiter for the public redeem endpoint (10/min).
// In-memory fixed windows, single-instance by design — same stance as
// lib/api/rate-limit.ts. The proxy's write tier (60/min/IP) is the outer
// bound; this is the tighter per-code bound.
// ---------------------------------------------------------------------------

const REDEEM_BUCKETS = new Map<string, { count: number; resetAt: number }>();
const REDEEM_LIMIT = 10;
const REDEEM_WINDOW_MS = 60_000;

export function checkRedeemRateLimit(code: string, ip: string): boolean {
  const key = `${code.trim().toUpperCase()}|${ip.trim().toLowerCase()}`;
  const now = Date.now();
  const cur = REDEEM_BUCKETS.get(key);
  if (!cur || now >= cur.resetAt) {
    REDEEM_BUCKETS.set(key, { count: 1, resetAt: now + REDEEM_WINDOW_MS });
    return true;
  }
  if (cur.count >= REDEEM_LIMIT) return false;
  cur.count += 1;
  return true;
}

/** Test hook: clear redeem rate-limit state. */
export function resetRedeemRateLimits(): void {
  REDEEM_BUCKETS.clear();
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface BundleStats {
  scans: number;
  calls: number;
  redemptions: number;
  leads: number;
  revenueCents: Record<AttributionModel, number>;
}

const NINETY_DAYS_MS = 90 * 86_400_000;

export async function bundleStats(
  bundle: BundleWithNumber,
  window?: ReportWindow,
): Promise<BundleStats> {
  const [scans, calls, redemptions] = await Promise.all([
    prisma.bundleScan.count({ where: { bundleId: bundle.id } }),
    bundle.numberId
      ? prisma.call.count({ where: { numberId: bundle.numberId } })
      : Promise.resolve(0),
    prisma.bundleRedemption.count({ where: { bundleId: bundle.id } }),
  ]);

  // Attributed revenue: reuse the C2 report and sum the bundle's campaign
  // across channels (qr_code, promo_code, phone…).
  const win: ReportWindow = window ?? { from: new Date(Date.now() - NINETY_DAYS_MS) };
  const { report } = await getAttributionReport(bundle.workspaceId, win);
  const revenueCents = {} as Record<AttributionModel, number>;
  const leadIds = new Set<string>();
  for (const m of ATTRIBUTION_MODELS) {
    let sum = 0;
    for (const c of report[m].campaigns) {
      if (c.campaign === bundle.campaignName) sum += c.revenueCents;
    }
    revenueCents[m] = sum;
  }
  const touched = await prisma.attributionTouch.findMany({
    where: { workspaceId: bundle.workspaceId, campaign: bundle.campaignName },
    select: { leadId: true },
    distinct: ["leadId"],
  });
  for (const t of touched) leadIds.add(t.leadId);

  return { scans, calls, redemptions, leads: leadIds.size, revenueCents };
}
