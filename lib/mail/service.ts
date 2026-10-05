// Marketr — Phase 4 T1: mail campaign orchestration (service layer).
//
// Pipeline: buildPieces → verifyAddresses → estimateCampaign →
// requestApproval → decideApproval → executeCampaign.
//
// MONEY RULES (enforced here, not in the providers):
// 1. Default everything closed: with no provider row, executeCampaign uses
//    the fake provider (render-only, nothing mailed).
// 2. A live send is IMPOSSIBLE unless ALL hold:
//      - a MailApproval exists for the campaign with status "approved",
//      - the approval's creativeHash matches the campaign creative's hash,
//      - sendable piece count <= approval.pieceCount,
//      - recomputed provider spend <= approval.maxSpendCents,
//      - the provider row's mode is "live" (live key).
//    Test mode (no row, or row mode "test") always renders via the fake
//    provider or the provider's test key — never physical mail.
// 3. Quarantined addresses are NEVER mailed — silently or otherwise.
// 4. Verification on Lob is a paid add-on: its cost is a line item in the
//    approved estimate. verifyAddresses() is an explicit campaign step.
// 5. Consent: lead-linked pieces require explicit "mail" opt-in
//    (ContactConsent channel "mail"). opted_out → suppressed/opt_out;
//    anything but opted_in → suppressed/no_consent (mirrors the R3
//    messaging dispatcher). Rows without a leadId (raw CSV addresses) are
//    advertiser-supplied and carry no consent row — they are sendable.

import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { secrets } from "@/lib/secrets";
import { capFits, checkCap, meter } from "@/lib/metering/service";
import {
  ProviderNotConfiguredError,
  sha256Hex,
  type CostLineItem,
  type EstimateSpec,
  type MailAddress,
  type MailFormat,
  type MailProvider as MailProviderIface,
  type MailProviderMode,
  type MailProviderName,
} from "./provider";
import { FakeMailProvider } from "./fake";
import { assertFakeProviderAllowed } from "@/lib/env/secrets";
import { LobProvider } from "./lob";
import { PostGridProvider } from "./postgrid";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/api/errors";
import { notifyApprovalDecided, notifyApprovalNeeded } from "@/lib/notifications/producers";

export const MAIL_CONSENT_CHANNEL = "mail";
export const SENDABLE_VERIFICATION = ["valid", "corrected"] as const;
/** Margin preview multiplier for hosted (spec §6: ~2–3× API cost). */
export const HOSTED_MARGIN_MULTIPLIER = 2;

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

export interface ResolvedMailProvider {
  provider: MailProviderIface;
  mode: MailProviderMode;
  /** Null when falling back to the fake provider (no row configured). */
  providerRowId: string | null;
  providerName: MailProviderName;
}

function constructProvider(
  name: string,
  key: string,
  webhookSecret: string | null,
): MailProviderIface {
  const n = name.trim().toLowerCase();
  if (n === "lob") return new LobProvider(key, { webhookSecret: webhookSecret ?? undefined });
  if (n === "postgrid") return new PostGridProvider(key, { webhookSecret: webhookSecret ?? undefined });
  throw new BadRequestError(`Unknown mail provider: ${name}`);
}

/**
 * Phase 11 (conncore): no Lob/PostGrid row → the render-only fake, which
 * production refuses ("direct mail is not connected").
 */
export function fallbackMailProvider(): ResolvedMailProvider {
  assertFakeProviderAllowed("direct mail");
  return { provider: new FakeMailProvider(), mode: "test", providerRowId: null, providerName: "fake" };
}

/**
 * Resolve the workspace's mail provider. No row → fake (render-only).
 * Mode "test" → real provider built with the TEST key (render-only at the
 * provider). Mode "live" → real provider with the LIVE key (real postage —
 * gated by executeCampaign's approval checks).
 */
export async function resolveMailProvider(workspaceId: string): Promise<ResolvedMailProvider> {
  const row = await prisma.mailProvider.findFirst({
    where: { workspaceId },
    orderBy: { updatedAt: "desc" },
  });
  if (!row) return fallbackMailProvider();
  const mode: MailProviderMode = row.mode === "live" ? "live" : "test";
  const enc = mode === "live" ? row.liveKeyEnc : row.testKeyEnc;
  if (!enc) {
    throw new ProviderNotConfiguredError(row.provider, mode === "live" ? "live key" : "test key");
  }
  const key = secrets().decrypt(enc);
  const webhookSecret = row.webhookSecretEnc ? secrets().decrypt(row.webhookSecretEnc) : null;
  const provider = constructProvider(row.provider, key, webhookSecret);
  return {
    provider,
    mode,
    providerRowId: row.id,
    providerName: provider.name,
  };
}

/** Look up a provider row by id, workspace-scoped (routes). */
export async function getMailProviderRow(workspaceId: string, id: string) {
  const row = await prisma.mailProvider.findFirst({ where: { id, workspaceId } });
  if (!row) throw new NotFoundError("Mail provider not found");
  return row;
}

// ---------------------------------------------------------------------------
// Consent (channel "mail" on ContactConsent)
// ---------------------------------------------------------------------------

export type MailConsentStatus = "unknown" | "pending" | "opted_in" | "opted_out";

export async function getMailConsent(
  workspaceId: string,
  leadId: string,
): Promise<MailConsentStatus> {
  const row = await prisma.contactConsent.findUnique({
    where: { workspaceId_leadId_channel: { workspaceId, leadId, channel: MAIL_CONSENT_CHANNEL } },
    select: { status: true },
  });
  const s = (row?.status ?? "unknown") as MailConsentStatus;
  return ["unknown", "pending", "opted_in", "opted_out"].includes(s) ? s : "unknown";
}

// ---------------------------------------------------------------------------
// Address extraction (leads carry addresses in customFields — free-form)
// ---------------------------------------------------------------------------

const ADDR_KEYS: Record<string, string[]> = {
  line1: ["line1", "address1", "addressLine1", "street", "streetAddress", "address"],
  line2: ["line2", "address2", "addressLine2", "apt", "suite", "unit"],
  city: ["city", "town", "locality"],
  state: ["state", "province", "region"],
  zip: ["zip", "zipCode", "postal", "postalCode", "zip_code"],
};

/** Pull a US address out of a lead's customFields (nested "address" object
 * or flat keys). Returns null when no usable address exists. */
export function extractAddressFromLead(lead: {
  name: string;
  customFields?: unknown;
}): MailAddress | null {
  const cf = (lead.customFields ?? {}) as Record<string, unknown>;
  const nested = (cf.address ?? cf.mailingAddress ?? {}) as Record<string, unknown>;
  const pick = (names: string[]): string => {
    for (const n of names) {
      const v = nested[n] ?? cf[n];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  const line1 = pick(ADDR_KEYS.line1);
  const city = pick(ADDR_KEYS.city);
  const state = pick(ADDR_KEYS.state);
  const zip = pick(ADDR_KEYS.zip);
  if (!line1 || !city || !state || !zip) return null;
  return {
    name: lead.name,
    line1,
    line2: pick(ADDR_KEYS.line2) || undefined,
    city,
    state,
    zip,
  };
}

// ---------------------------------------------------------------------------
// Audience → pieces
// ---------------------------------------------------------------------------

export type AudienceKind = "crm_segment" | "prospect_list" | "csv";

export interface AudienceSpec {
  kind: AudienceKind;
  /** crm_segment: JSON filters; prospect_list: listId; csv: unused. */
  ref?: string;
  /** csv rows (also accepted for other kinds as direct input). */
  rows?: Array<{
    name?: string;
    line1: string;
    line2?: string;
    city: string;
    state: string;
    zip: string;
    leadId?: string;
  }>;
}

export interface CrmSegmentFilter {
  pipelineId?: string;
  stage?: string;
  source?: string;
  minScore?: number;
  limit?: number;
}

function randomSuffix(bytes = 5): string {
  return randomBytes(bytes).toString("hex");
}

async function uniqueQrSlug(base: string): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const candidate = i === 0 ? `${base}-${randomSuffix()}` : `${base}-${randomSuffix()}`;
    const hit = await prisma.mailPiece.findUnique({
      where: { qrSlug: candidate },
      select: { id: true },
    });
    if (!hit) return candidate;
  }
  throw new Error("Could not mint a unique mail QR slug");
}

async function getCampaign(workspaceId: string, campaignId: string) {
  const c = await prisma.mailCampaign.findFirst({
    where: { id: campaignId, workspaceId },
    include: { creative: true },
  });
  if (!c) throw new NotFoundError("Mail campaign not found");
  return c;
}

export interface BuildPiecesResult {
  created: number;
  skippedNoAddress: number;
  total: number;
}

/** Build MailPieces from an audience source. Idempotent per campaign run:
 * pieces are only built while the campaign is in draft. */
export async function buildPieces(
  workspaceId: string,
  campaignId: string,
  audience: AudienceSpec,
): Promise<BuildPiecesResult> {
  const campaign = await getCampaign(workspaceId, campaignId);
  if (campaign.status !== "draft") {
    throw new ConflictError(`Cannot build pieces: campaign is ${campaign.status} (must be draft)`);
  }
  const slugBase = campaign.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 24)
    .replace(/^-+|-+$/g, "") || "mail";

  const candidates: Array<{ address: MailAddress; leadId: string | null }> = [];
  let skippedNoAddress = 0;

  if (audience.kind === "csv") {
    for (const r of audience.rows ?? []) {
      if (!r.line1?.trim() || !r.city?.trim() || !r.state?.trim() || !r.zip?.trim()) {
        skippedNoAddress++;
        continue;
      }
      candidates.push({
        address: {
          name: (r.name ?? "").trim() || "Valued customer",
          line1: r.line1.trim(),
          line2: r.line2?.trim() || undefined,
          city: r.city.trim(),
          state: r.state.trim(),
          zip: r.zip.trim(),
        },
        leadId: r.leadId ?? null,
      });
    }
  } else if (audience.kind === "prospect_list") {
    const listId = (audience.ref ?? "").trim();
    if (!listId) throw new BadRequestError("prospect_list audience requires ref = ProspectList id");
    const prospects = await prisma.prospect.findMany({
      where: { listId, workspaceId },
      select: { leadId: true },
      take: 5000,
    });
    for (const p of prospects) {
      if (!p.leadId) {
        skippedNoAddress++;
        continue;
      }
      const lead = await prisma.lead.findFirst({
        where: { id: p.leadId, workspaceId },
        select: { id: true, name: true, customFields: true },
      });
      const addr = lead ? extractAddressFromLead(lead) : null;
      if (!addr) {
        skippedNoAddress++;
        continue;
      }
      candidates.push({ address: addr, leadId: lead!.id });
    }
  } else {
    // crm_segment
    let filter: CrmSegmentFilter = {};
    try {
      filter = audience.ref ? (JSON.parse(audience.ref) as CrmSegmentFilter) : {};
    } catch {
      throw new BadRequestError("crm_segment ref must be JSON: {pipelineId?, stage?, source?, minScore?, limit?}");
    }
    const where: Record<string, unknown> = { workspaceId };
    if (filter.pipelineId) where.pipelineId = filter.pipelineId;
    if (filter.stage) where.stage = filter.stage;
    if (filter.source) where.source = filter.source;
    if (typeof filter.minScore === "number") where.score = { gte: filter.minScore };
    const leads = await prisma.lead.findMany({
      where,
      select: { id: true, name: true, customFields: true },
      take: Math.min(Math.max(filter.limit ?? 5000, 1), 20000),
      orderBy: { createdAt: "asc" },
    });
    for (const lead of leads) {
      const addr = extractAddressFromLead(lead);
      if (!addr) {
        skippedNoAddress++;
        continue;
      }
      candidates.push({ address: addr, leadId: lead.id });
    }
  }

  let created = 0;
  for (const c of candidates) {
    const qrSlug = await uniqueQrSlug(slugBase);
    await prisma.mailPiece.create({
      data: {
        campaignId: campaign.id,
        leadId: c.leadId,
        addressSnapshot: c.address as unknown as Prisma.InputJsonValue,
        verificationStatus: "pending",
        qrSlug,
        status: "queued",
      },
    });
    created++;
  }
  await prisma.mailCampaign.update({
    where: { id: campaign.id },
    data: { pieceCount: created, audienceSource: { kind: audience.kind, ref: audience.ref ?? null } as unknown as Prisma.InputJsonValue },
  });
  return { created, skippedNoAddress, total: candidates.length + skippedNoAddress };
}

// ---------------------------------------------------------------------------
// Verification (explicit step; Lob charges per lookup — cost is estimated)
// ---------------------------------------------------------------------------

export interface VerifyResult {
  valid: number;
  corrected: number;
  quarantined: number;
  metered: number;
}

export async function verifyAddresses(
  workspaceId: string,
  campaignId: string,
): Promise<VerifyResult> {
  const campaign = await getCampaign(workspaceId, campaignId);
  if (campaign.status !== "draft") {
    throw new ConflictError(`Cannot verify: campaign is ${campaign.status} (must be draft)`);
  }
  const { provider } = await resolveMailProvider(workspaceId);
  const pieces = await prisma.mailPiece.findMany({
    where: { campaignId: campaign.id, verificationStatus: "pending", status: "queued" },
    orderBy: { createdAt: "asc" },
  });
  const out: VerifyResult = { valid: 0, corrected: 0, quarantined: 0, metered: 0 };
  for (const piece of pieces) {
    const addr = piece.addressSnapshot as unknown as MailAddress;
    let result;
    try {
      result = await provider.verifyAddress(addr);
    } catch (e) {
      // A verification API failure quarantines rather than silently mailing.
      result = {
        status: "quarantined" as const,
        deliverability: "verification_error",
        notes: `Verification failed: ${(e instanceof Error ? e.message : "unknown").slice(0, 200)}`,
      };
    }
    const snapshot = result.correctedAddress ?? addr;
    await prisma.mailPiece.update({
      where: { id: piece.id },
      data: {
        verificationStatus: result.status,
        addressSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        ...(result.status === "quarantined" ? { status: "queued" as const } : {}),
      },
    });
    out[result.status === "valid" ? "valid" : result.status === "corrected" ? "corrected" : "quarantined"]++;
    // Meter the lookup (idempotent per piece).
    try {
      const m = await meter({
        workspaceId,
        action: "mail_verification",
        idempotencyKey: `mail-verify:${piece.id}`,
        evidenceRef: `mail-piece:${piece.id}`,
      });
      if (m.ok) out.metered++;
    } catch {
      // Metering must never block verification bookkeeping.
    }
  }
  await prisma.mailCampaign.update({
    where: { id: campaign.id },
    data: { verifiedCount: out.valid + out.corrected, quarantinedCount: out.quarantined },
  });
  return out;
}

// ---------------------------------------------------------------------------
// Estimate (line items + hosted margin preview)
// ---------------------------------------------------------------------------

export function formatForCreative(creative: { size: string } | null): MailFormat {
  const s = (creative?.size ?? "").trim().toLowerCase().replace(/\s/g, "");
  if (s === "6x9") return "postcard_6x9";
  if (s === "6x11") return "postcard_6x11";
  if (s === "letter" || s === "#10" || s === "10") return "letter";
  return "postcard_4x6";
}

export interface EstimateResult {
  lineItems: CostLineItem[];
  subtotalCents: number;
  /** Hosted margin preview: subtotal × (multiplier − 1). */
  marginPreviewCents: number;
  /** What the customer would be quoted on hosted (subtotal + margin). */
  totalWithMarginCents: number;
  sendablePieces: number;
  pendingVerifications: number;
}

export async function estimateCampaign(
  workspaceId: string,
  campaignId: string,
): Promise<EstimateResult> {
  const campaign = await getCampaign(workspaceId, campaignId);
  const { provider } = await resolveMailProvider(workspaceId);
  const [sendablePieces, pendingVerifications] = await Promise.all([
    prisma.mailPiece.count({
      where: {
        campaignId: campaign.id,
        status: "queued",
        verificationStatus: { in: [...SENDABLE_VERIFICATION] },
      },
    }),
    prisma.mailPiece.count({
      where: { campaignId: campaign.id, verificationStatus: "pending", status: "queued" },
    }),
  ]);
  const format = formatForCreative(campaign.creative);
  const spec: EstimateSpec = { format, count: sendablePieces, verifications: pendingVerifications };
  const lineItems = await provider.estimateCost(spec);
  const subtotalCents = lineItems.reduce((s, l) => s + l.cents, 0);
  const marginPreviewCents = subtotalCents * (HOSTED_MARGIN_MULTIPLIER - 1);
  const totalWithMarginCents = subtotalCents + marginPreviewCents;
  await prisma.mailCampaign.update({
    where: { id: campaign.id },
    data: { estCostCents: subtotalCents },
  });
  return { lineItems, subtotalCents, marginPreviewCents, totalWithMarginCents, sendablePieces, pendingVerifications };
}

// ---------------------------------------------------------------------------
// Approval (C3 pattern: bind creative hash + piece count + max spend)
// ---------------------------------------------------------------------------

export async function requestApproval(
  workspaceId: string,
  campaignId: string,
  opts?: { requestedBy?: string },
) {
  const campaign = await getCampaign(workspaceId, campaignId);
  if (!["draft", "pending_approval"].includes(campaign.status)) {
    throw new ConflictError(`Cannot request approval: campaign is ${campaign.status}`);
  }
  const creative = campaign.creative;
  if (!creative?.creativeHash) {
    throw new ConflictError("Campaign creative has no hash — creative must be finalized (T2 Studio) before approval");
  }
  const estimate = await estimateCampaign(workspaceId, campaignId);
  if (estimate.sendablePieces === 0) {
    throw new ConflictError("Nothing to approve: no sendable (verified) pieces");
  }
  const approval = await prisma.mailApproval.create({
    data: {
      campaignId: campaign.id,
      creativeHash: creative.creativeHash,
      pieceCount: estimate.sendablePieces,
      maxSpendCents: estimate.totalWithMarginCents,
      status: "pending",
      approverId: opts?.requestedBy ?? null,
    },
  });
  await prisma.mailCampaign.update({
    where: { id: campaign.id },
    data: { status: "pending_approval" },
  });
  // Phase 3 (J): best-effort "needs you" notification (never throws).
  await notifyApprovalNeeded({
    workspaceId,
    source: "mail",
    sourceId: approval.id,
    title: `${campaign.name ?? "Direct mail campaign"} · ${estimate.sendablePieces} pieces`,
    href: "/dashboard/mail",
    requestedBy: opts?.requestedBy ?? null,
  });
  return { approval, estimate };
}

export async function decideApproval(
  workspaceId: string,
  approvalId: string,
  decision: "approve" | "reject",
  approverId: string,
  note?: string,
) {
  const approval = await prisma.mailApproval.findFirst({
    where: { id: approvalId },
    include: { campaign: { select: { id: true, workspaceId: true, status: true, name: true, createdBy: true } } },
  });
  if (!approval || approval.campaign.workspaceId !== workspaceId) {
    throw new NotFoundError("Approval not found");
  }
  if (approval.status !== "pending") {
    throw new ConflictError(`Approval is already ${approval.status}`);
  }
  const now = new Date();
  const updated = await prisma.mailApproval.update({
    where: { id: approval.id },
    data: {
      status: decision === "approve" ? "approved" : "rejected",
      approverId,
      decidedAt: now,
      note: note?.slice(0, 1000) ?? null,
    },
  });
  await prisma.mailCampaign.update({
    where: { id: approval.campaignId },
    data: { status: decision === "approve" ? "approved" : "cancelled" },
  });
  // Phase 4a: best-effort "decided" notification (never throws). Until it
  // is decided, approverId holds the requester (set by requestApproval).
  await notifyApprovalDecided({
    workspaceId,
    source: "mail",
    sourceId: approval.id,
    title: `${approval.campaign.name ?? "Direct mail campaign"} · ${approval.pieceCount} pieces`,
    decision: decision === "approve" ? "approved" : "denied",
    decidedBy: approverId,
    requestedBy: approval.approverId ?? approval.campaign.createdBy ?? null,
    href: "/dashboard/mail",
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Execute (the money gate)
// ---------------------------------------------------------------------------

export interface ExecuteResult {
  sent: number;
  suppressed: number;
  failed: number;
  quarantinedSkipped: number;
  spendCents: number;
  mode: MailProviderMode;
  renderedOnly: boolean;
  /** Phase 15.2: the send stopped because the workspace's credit cap was
   *  reached; the remaining pieces stay queued (nothing charged for them). */
  stoppedAtCap?: boolean;
  capMessage?: string;
}

/**
 * Phase 15.2: credits for one mail piece — the provider's per-piece cost at
 * HOSTED_MARGIN_MULTIPLIER (2×), 1 credit = 1¢, rounded up.
 */
export function mailPieceCredits(perPieceCents: number): number {
  if (!(perPieceCents > 0)) return 0;
  return Math.ceil(perPieceCents * HOSTED_MARGIN_MULTIPLIER);
}

export async function executeCampaign(
  workspaceId: string,
  campaignId: string,
): Promise<ExecuteResult> {
  const campaign = await getCampaign(workspaceId, campaignId);
  if (!["approved"].includes(campaign.status)) {
    throw new ConflictError(
      `Refusing to send: campaign is ${campaign.status} (must be approved)`,
    );
  }
  const approval = await prisma.mailApproval.findFirst({
    where: { campaignId: campaign.id, status: "approved" },
    orderBy: { decidedAt: "desc" },
  });
  if (!approval) {
    throw new ConflictError("Refusing to send: no approved MailApproval for this campaign");
  }
  const creative = campaign.creative;
  if (!creative?.creativeHash || creative.creativeHash !== approval.creativeHash) {
    throw new ConflictError("Refusing to send: creative hash changed since approval (hash mismatch)");
  }

  // Provider + mode. Live mode demands an approved approval (have it) and a
  // provider row in mode "live" (checked below). Everything else renders.
  const resolved = await resolveMailProvider(workspaceId);
  const liveMode = resolved.mode === "live" && resolved.providerRowId !== null;
  const provider: MailProviderIface = liveMode ? resolved.provider : new FakeMailProvider();
  const effectiveName: MailProviderName = liveMode ? resolved.providerName : "fake";

  const pieces = await prisma.mailPiece.findMany({
    where: { campaignId: campaign.id, status: "queued" },
    orderBy: { createdAt: "asc" },
  });
  const sendable = pieces.filter((p) => (SENDABLE_VERIFICATION as readonly string[]).includes(p.verificationStatus));
  const quarantinedSkipped = pieces.length - sendable.length;

  if (sendable.length > approval.pieceCount) {
    throw new ConflictError(
      `Refusing to send: ${sendable.length} sendable pieces exceeds approved ${approval.pieceCount} (over-count)`,
    );
  }

  // Recompute spend against the same table the approval bound, and enforce.
  const format = formatForCreative(creative);
  const estimateLines = await provider.estimateCost({ format, count: sendable.length, verifications: 0 });
  const spendCents = estimateLines.reduce((s, l) => s + l.cents, 0);
  if (spendCents > approval.maxSpendCents) {
    throw new ConflictError(
      `Refusing to send: estimated spend ${spendCents}¢ exceeds approved max ${approval.maxSpendCents}¢ (over-spend)`,
    );
  }
  const perPieceCents = sendable.length > 0 ? Math.ceil(spendCents / sendable.length) : 0;

  await prisma.mailCampaign.update({
    where: { id: campaign.id },
    data: { status: "sending" },
  });

  const out: ExecuteResult = {
    sent: 0,
    suppressed: 0,
    failed: 0,
    quarantinedSkipped,
    spendCents: 0,
    mode: liveMode ? "live" : "test",
    renderedOnly: !liveMode,
  };

  const pieceCredits = mailPieceCredits(perPieceCents);
  for (const piece of sendable) {
    const addr = piece.addressSnapshot as unknown as MailAddress;
    // Consent gate (mirrors the R3 messaging dispatcher).
    if (piece.leadId) {
      const consent = await getMailConsent(workspaceId, piece.leadId);
      if (consent === "opted_out") {
        await prisma.mailPiece.update({
          where: { id: piece.id },
          data: { status: "suppressed", suppressionReason: "opt_out" },
        });
        out.suppressed++;
        continue;
      }
      if (consent !== "opted_in") {
        await prisma.mailPiece.update({
          where: { id: piece.id },
          data: { status: "suppressed", suppressionReason: "no_consent" },
        });
        out.suppressed++;
        continue;
      }
    }
    // Phase 15.2: stop the send on cap_exceeded — the piece's credits must
    // fit (or overage be on) BEFORE postage is spent. The remaining pieces
    // stay queued and nothing is charged for them.
    if (pieceCredits > 0) {
      const cap = await checkCap(workspaceId);
      if (!capFits(cap, pieceCredits)) {
        out.stoppedAtCap = true;
        out.capMessage =
          `Credit cap reached (${cap.used.toLocaleString()} of ${cap.capCredits.toLocaleString()} credits used) — ` +
          `${out.sent} piece${out.sent === 1 ? "" : "s"} sent, the rest stay queued. Raise the cap or add credits in Settings → Usage.`;
        break;
      }
    }
    try {
      const res = await provider.sendPiece(
        {
          address: addr,
          qrSlug: piece.qrSlug ?? `mail-${piece.id}`,
          idempotencyKey: sha256Hex(`mail:${workspaceId}:${piece.id}`).slice(0, 64),
          mergeVariables: { name: addr.name },
        },
        { testMode: !liveMode },
      );
      await prisma.mailPiece.update({
        where: { id: piece.id },
        data: {
          status: "sent",
          providerPieceId: res.providerPieceId,
          costCents: perPieceCents,
          sentAt: new Date(),
        },
      });
      out.sent++;
      out.spendCents += perPieceCents;
      try {
        await meter({
          workspaceId,
          action: "mail_piece",
          // Phase 15.2: provider cost × HOSTED_MARGIN_MULTIPLIER (1 credit = 1¢).
          // Recorded after the fact — the piece was sent (the cap was checked
          // before it); idempotent per piece.
          credits: pieceCredits,
          afterTheFact: true,
          idempotencyKey: `mail-send:${piece.id}`,
          evidenceRef: `mail-piece:${piece.id}:${effectiveName}`,
        });
      } catch {
        // Metering must never break the send ledger.
      }
    } catch (e) {
      await prisma.mailPiece.update({
        where: { id: piece.id },
        data: { status: "failed", suppressionReason: (e instanceof Error ? e.message : "send failed").slice(0, 300) },
      });
      out.failed++;
    }
  }

  await prisma.mailCampaign.update({
    where: { id: campaign.id },
    data: {
      // Phase 15.2: stopped at the cap → "cap_reached" (remaining pieces queued).
      status: out.stoppedAtCap ? "cap_reached" : out.failed > 0 && out.sent === 0 ? "failed" : "complete",
      mailedAt: new Date(),
      actualCostCents: out.spendCents,
    },
  });
  return out;
}

// ---------------------------------------------------------------------------
// Creative hash helper (T2 Studio owns creative authoring; this is the
// binding primitive campaigns use).
// ---------------------------------------------------------------------------

/** sha256 of canonical creative bytes — bound to the approval record. */
export function creativeHashFor(bytes: Buffer | string): string {
  return sha256Hex(typeof bytes === "string" ? bytes : bytes.toString("binary"));
}
