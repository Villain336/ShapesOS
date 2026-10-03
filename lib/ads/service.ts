// Marketr — ad factory service (milestone 21).
//
// Prisma-backed orchestration for the Higgsfield ad factory: workspace
// settings (BYO API key, monthly spend cap), campaigns, brief → variant
// fan-out, async generation with a polling state machine, review actions,
// cost accounting, and send-to-social. All provider I/O goes through the
// injected HiggsfieldPort (real API in production, MockHiggsfieldPort in
// tests). Pure prompt composition lives in ./brief.ts.

import type { Prisma, PrismaClient } from "@prisma/client";
import { secrets } from "@/lib/secrets";
import { emitAlert } from "@/lib/alerts/evaluate";
import { queuePostizDraft } from "@/lib/integrations/postiz";
import {
  buildAdPrompt,
  estimateCostCents,
  fanOutVariants,
  validateBrief,
  type AdBrief,
  type AspectRatio,
  type BrandConstraints,
} from "./brief";
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  isTransientHiggsfieldError,
  type HiggsfieldPort,
} from "./higgsfield";

type Db = PrismaClient;

type AuditAction =
  | "ad_campaign_created"
  | "ad_campaign_updated"
  | "ad_campaign_deleted"
  | "ad_higgsfield_key_updated"
  | "ad_higgsfield_key_revoked"
  | "ad_generation_started"
  | "ad_generation_completed"
  | "ad_generation_failed"
  | "ad_creative_approved"
  | "ad_creative_rejected"
  | "ad_creative_regenerated"
  | "ad_sent_to_social";

/** Shared audit helper — every ad mutation is audit-logged. */
export async function auditAds(
  db: Db,
  workspaceId: string,
  projectId: string | null,
  action: AuditAction,
  summary: string,
  actor: "user" | "system" = "user",
): Promise<void> {
  await db.fileChangeLog.create({
    data: {
      workspaceId,
      projectId: projectId ?? "",
      connectionId: null,
      filePath: "",
      actor,
      action,
      summary: summary.slice(0, 280),
    },
  });
}

export function currentPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Poll cadence for in-flight generation jobs. */
export const POLL_INTERVAL_MS = 30_000;
/** Max polling attempts before a job is declared stuck/failed (~20 min). */
export const MAX_POLL_ATTEMPTS = 40;
/** Max submit attempts for a queued job with a transient provider error. */
export const MAX_SUBMIT_ATTEMPTS = 3;

export class AdGuardError extends Error {}

// ---------------------------------------------------------------------------
// Settings — BYO Higgsfield API key + monthly spend cap
// ---------------------------------------------------------------------------

export async function getAdSettings(db: Db, workspaceId: string) {
  return db.adSettings.findUnique({ where: { workspaceId } });
}

export async function setHiggsfieldKey(
  db: Db,
  workspaceId: string,
  key: string,
  actor: "user" | "system" = "user",
): Promise<{ hint: string }> {
  const trimmed = key.trim();
  if (!trimmed) throw new AdGuardError("Higgsfield API key is required.");
  const enc = secrets().encrypt(trimmed);
  const hint = secrets().hint(trimmed);
  await db.adSettings.upsert({
    where: { workspaceId },
    create: { workspaceId, higgsfieldKeyEnc: enc, higgsfieldKeyHint: hint },
    update: { higgsfieldKeyEnc: enc, higgsfieldKeyHint: hint },
  });
  await auditAds(db, workspaceId, null, "ad_higgsfield_key_updated", "Higgsfield API key updated.", actor);
  return { hint };
}

export async function revokeHiggsfieldKey(
  db: Db,
  workspaceId: string,
  actor: "user" | "system" = "user",
): Promise<void> {
  await db.adSettings.upsert({
    where: { workspaceId },
    create: { workspaceId },
    update: { higgsfieldKeyEnc: null, higgsfieldKeyHint: null },
  });
  await auditAds(db, workspaceId, null, "ad_higgsfield_key_revoked", "Higgsfield API key revoked.", actor);
}

/** Upper bound for the monthly ad spend cap ($10,000 — day-1 hardening, M2). */
export const MAX_SPEND_CAP_CENTS = 1_000_000;

export async function updateSpendCap(
  db: Db,
  workspaceId: string,
  monthlyCapCents: number,
  actor: "user" | "system" = "user",
): Promise<void> {
  if (!Number.isFinite(monthlyCapCents) || monthlyCapCents < 0) {
    throw new AdGuardError("Monthly cap must be a non-negative number of cents.");
  }
  if (monthlyCapCents > MAX_SPEND_CAP_CENTS) {
    throw new AdGuardError(
      `Monthly cap cannot exceed $${(MAX_SPEND_CAP_CENTS / 100).toFixed(0)}.`,
    );
  }
  await db.adSettings.upsert({
    where: { workspaceId },
    create: { workspaceId, monthlyCapCents: Math.floor(monthlyCapCents) },
    update: { monthlyCapCents: Math.floor(monthlyCapCents) },
  });
}

/** Live port for the workspace, or null when no key is configured. */
export async function getHiggsfieldPort(
  db: Db,
  workspaceId: string,
  factory: (key: string) => HiggsfieldPort,
): Promise<HiggsfieldPort | null> {
  const settings = await db.adSettings.findUnique({ where: { workspaceId } });
  if (!settings?.higgsfieldKeyEnc) return null;
  return factory(secrets().decrypt(settings.higgsfieldKeyEnc));
}

/** Reset the rolling spend window when the calendar month flips. */
async function resetSpendIfNewPeriod(db: Db, workspaceId: string): Promise<void> {
  const settings = await db.adSettings.findUnique({ where: { workspaceId } });
  if (!settings) return;
  const period = currentPeriod();
  if (settings.spendPeriod !== period) {
    await db.adSettings.update({
      where: { workspaceId },
      data: { spendCents: 0, spendPeriod: period },
    });
  }
}

export interface SpendSummary {
  period: string;
  spendCents: number;
  capCents: number;
  remainingCents: number;
  atCap: boolean;
}

export async function getSpendSummary(db: Db, workspaceId: string): Promise<SpendSummary> {
  await resetSpendIfNewPeriod(db, workspaceId);
  const settings = await db.adSettings.findUnique({ where: { workspaceId } });
  const period = currentPeriod();
  const spendCents = settings?.spendPeriod === period ? settings.spendCents : 0;
  const capCents = settings?.monthlyCapCents ?? 5000;
  return { period, spendCents, capCents, remainingCents: Math.max(0, capCents - spendCents), atCap: spendCents >= capCents };
}

/** Server-side spend gate — throws when the cap would be exceeded. */
export async function checkCap(db: Db, workspaceId: string, additionalCents: number): Promise<void> {
  const summary = await getSpendSummary(db, workspaceId);
  if (summary.spendCents + additionalCents > summary.capCents) {
    throw new AdGuardError(
      `Monthly ad spend cap reached ($${(summary.capCents / 100).toFixed(2)}). Raise the cap in ad settings to generate more.`,
    );
  }
}

async function recordSpend(db: Db, workspaceId: string, cents: number): Promise<void> {
  await resetSpendIfNewPeriod(db, workspaceId);
  await db.adSettings.update({
    where: { workspaceId },
    data: { spendCents: { increment: cents }, spendPeriod: currentPeriod() },
  });
}

// ---------------------------------------------------------------------------
// Brand constraints (M12 brand kits)
// ---------------------------------------------------------------------------

export async function getBrandConstraints(
  db: Db,
  workspaceId: string,
  brandKitId: string | null,
): Promise<BrandConstraints | null> {
  if (!brandKitId) return null;
  const kit = await db.brandKit.findFirst({ where: { id: brandKitId, workspaceId } });
  if (!kit) return null;
  const colors = (kit.colors ?? {}) as Record<string, string>;
  const fonts = (kit.fonts ?? {}) as Record<string, string>;
  return { colors, fonts, tone: kit.tone ?? null, hasLogo: !!kit.logoPath };
}

/** A campaign may only reference a brand kit from its own workspace. */
async function assertBrandKitInWorkspace(db: Db, workspaceId: string, brandKitId: string | null | undefined) {
  if (!brandKitId) return;
  const kit = await db.brandKit.findFirst({ where: { id: brandKitId, workspaceId }, select: { id: true } });
  if (!kit) throw new AdGuardError("Brand kit not found in this workspace.");
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export async function listCampaigns(db: Db, projectId: string) {
  return db.adCampaign.findMany({
    where: { projectId },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { creatives: true } } },
  });
}

export async function createCampaign(
  db: Db,
  workspaceId: string,
  projectId: string,
  args: { name: string; objective?: string; brandKitId?: string | null; channels?: string[] },
  actor: "user" | "system" = "user",
) {
  const name = args.name.trim();
  if (!name) throw new AdGuardError("Campaign name is required.");
  await assertBrandKitInWorkspace(db, workspaceId, args.brandKitId);
  const campaign = await db.adCampaign.create({
    data: {
      projectId,
      name,
      objective: args.objective?.trim() || null,
      brandKitId: args.brandKitId ?? null,
      channels: args.channels ?? [],
    },
  });
  await auditAds(db, workspaceId, projectId, "ad_campaign_created", `Ad campaign created: ${name}`, actor);
  return campaign;
}

export async function updateCampaign(
  db: Db,
  workspaceId: string,
  campaignId: string,
  args: { name?: string; objective?: string | null; brandKitId?: string | null; channels?: string[] },
  actor: "user" | "system" = "user",
) {
  const data: Record<string, unknown> = {};
  if (args.name !== undefined) {
    const name = args.name.trim();
    if (!name) throw new AdGuardError("Campaign name is required.");
    data.name = name;
  }
  if (args.objective !== undefined) data.objective = args.objective?.trim() || null;
  if (args.brandKitId !== undefined) {
    await assertBrandKitInWorkspace(db, workspaceId, args.brandKitId);
    data.brandKitId = args.brandKitId;
  }
  if (args.channels !== undefined) data.channels = args.channels;
  const campaign = await db.adCampaign.update({ where: { id: campaignId }, data });
  await auditAds(db, workspaceId, campaign.projectId, "ad_campaign_updated", `Ad campaign updated: ${campaign.name}`, actor);
  return campaign;
}

export async function deleteCampaign(
  db: Db,
  workspaceId: string,
  campaignId: string,
  actor: "user" | "system" = "user",
) {
  const campaign = await db.adCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new AdGuardError("Campaign not found.");
  await db.adCampaign.delete({ where: { id: campaignId } });
  await auditAds(db, workspaceId, campaign.projectId, "ad_campaign_deleted", `Ad campaign deleted: ${campaign.name}`, actor);
}

// ---------------------------------------------------------------------------
// Generation — brief → variant fan-out → jobs
// ---------------------------------------------------------------------------

export interface GenerateArgs {
  brief: AdBrief;
  type: "image" | "video";
  aspectRatio: AspectRatio;
  channels?: string[];
  variants: number;
  /** Optional reference image for image-to-video (verified route). */
  referenceImageUrl?: string;
  /** Override the provider model path (defaults per type). */
  modelPath?: string;
  name?: string;
}

export interface GenerateResult {
  created: number;
  creativeIds: string[];
  costEstimateCents: number;
}

/**
 * Generate N creative variants from one brief. Explicit user action only —
 * there is no auto-regeneration loop anywhere in the factory.
 */
export async function generateCreatives(
  db: Db,
  workspaceId: string,
  projectId: string,
  campaignId: string,
  args: GenerateArgs,
  port: HiggsfieldPort,
  actor: "user" | "system" = "user",
): Promise<GenerateResult> {
  const campaign = await db.adCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign || campaign.projectId !== projectId) throw new AdGuardError("Campaign not found.");
  // Server-side guard: brand kit is mandatory before generation.
  if (!campaign.brandKitId) {
    throw new AdGuardError("Select a brand kit for this campaign before generating — generation is blocked without one.");
  }
  const briefErrors = validateBrief(args.brief);
  if (briefErrors.length) throw new AdGuardError(briefErrors.join(" "));
  const variants = Math.max(1, Math.min(8, Math.floor(args.variants)));
  const estimate = estimateCostCents(args.type, variants);
  await checkCap(db, workspaceId, estimate);

  const brand = await getBrandConstraints(db, workspaceId, campaign.brandKitId);
  if (!brand) throw new AdGuardError("The campaign's brand kit no longer exists — pick another one.");

  const modelPath = args.modelPath ?? (args.type === "video" ? DEFAULT_VIDEO_MODEL : DEFAULT_IMAGE_MODEL);
  const prompts = fanOutVariants(args.brief, brand, args.type, args.aspectRatio, variants);
  const perVariantEstimate = estimateCostCents(args.type, 1);
  const created: string[] = [];

  for (let i = 0; i < prompts.length; i++) {
    const { prompt, negativePrompt } = prompts[i];
    const creative = await db.adCreative.create({
      data: {
        campaignId,
        projectId,
        name: args.name?.trim() || `${campaign.name} — variant ${i + 1}`,
        type: args.type,
        brief: args.brief as unknown as object,
        prompt,
        promptHistory: [],
        status: "queued",
        aspectRatio: args.aspectRatio,
        channels: args.channels ?? campaign.channels ?? [],
        costEstimateCents: perVariantEstimate,
        costActualCents: 0,
        assets: [],
      },
    });
    created.push(creative.id);
    // Submit the provider job immediately (best effort); the cron sweep
    // retries anything that stays queued.
    await submitJob(db, workspaceId, creative.id, port, {
      modelPath,
      referenceImageUrl: args.referenceImageUrl,
      negativePrompt,
    }, actor).catch(() => {
      // submitJob records its own failure state; never break the batch.
    });
  }

  await auditAds(
    db,
    workspaceId,
    projectId,
    "ad_generation_started",
    `Generation started: ${variants} ${args.type} variant(s) for "${campaign.name}" (~$${(estimate / 100).toFixed(2)} est.)`,
    actor,
  );
  return { created: created.length, creativeIds: created, costEstimateCents: estimate };
}

interface SubmitOpts {
  modelPath: string;
  referenceImageUrl?: string;
  negativePrompt?: string;
}

/** Submit a provider job for a queued creative; idempotent on providerJobId. */
/**
 * Persist a provider job id with retries (day-1 fix, edge #12). Returns true
 * when the id is safely stored; false when persistence kept failing — the
 * caller then stashes the id in the row's error field + audit log so the
 * billable job is never silently lost.
 */
async function persistSubmittedJob(
  db: Db,
  creativeId: string,
  requestId: string,
  attempts: number,
): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    try {
      await db.adCreative.update({
        where: { id: creativeId },
        data: {
          providerJobId: requestId,
          status: "generating",
          attempts: attempts + 1,
          nextPollAt: new Date(Date.now() + POLL_INTERVAL_MS),
          error: null,
        },
      });
      return true;
    } catch {
      if (i < 2) await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  return false;
}

/**
 * Adopt a stashed provider job id (day-1 fix, edge #12 recovery). When a
 * submit was acknowledged by the provider but the id persistence failed, the
 * id lives in the row's error field as `providerJobId=<id>`. Adopting it lets
 * polling + spend tracking proceed instead of losing the job.
 */
async function adoptStashedJobId(
  db: Db,
  creative: { id: string; error: string | null },
): Promise<boolean> {
  const m = creative.error?.match(/providerJobId=([A-Za-z0-9_-]+)/);
  if (!m) return false;
  await db.adCreative.update({
    where: { id: creative.id },
    data: { providerJobId: m[1], error: null },
  });
  return true;
}

export async function submitJob(
  db: Db,
  workspaceId: string,
  creativeId: string,
  port: HiggsfieldPort,
  opts: SubmitOpts,
  actor: "user" | "system" = "user",
): Promise<{ outcome: "submitted" | "noop" | "retrying" | "failed"; requestId?: string; error?: string }> {
  const creative = await db.adCreative.findUnique({ where: { id: creativeId } });
  if (!creative) throw new AdGuardError("Creative not found.");
  if (creative.providerJobId) return { outcome: "noop", requestId: creative.providerJobId };
  if (creative.status !== "queued") return { outcome: "noop" };

  // Day-1 fix (edge #11): atomic claim. The old read-then-submit let two
  // concurrent sweeps both see providerJobId == null and submit twice —
  // double provider job, double spend. The claim moves queued → generating
  // BEFORE the provider call; exactly one submitter can win it. nextPollAt
  // bounds the claim: if the worker dies between claim and provider ack, the
  // sweep reclaims the row after 15 minutes (never auto-resubmits — a charge
  // may exist — it is surfaced for human review instead).
  const claimed = await db.adCreative.updateMany({
    where: { id: creativeId, status: "queued", providerJobId: null },
    data: { status: "generating", error: null, nextPollAt: new Date(Date.now() + 15 * 60_000) },
  });
  if (claimed.count === 0) {
    const cur = await db.adCreative.findUnique({
      where: { id: creativeId },
      select: { providerJobId: true },
    });
    return { outcome: "noop", requestId: cur?.providerJobId ?? undefined };
  }

  const providerArgs: Record<string, unknown> = {
    prompt: creative.prompt,
    ...(opts.negativePrompt ? { negative_prompt: opts.negativePrompt } : {}),
    aspect_ratio: creative.aspectRatio,
  };
  if (creative.type === "video") {
    if (opts.referenceImageUrl) providerArgs.image_url = opts.referenceImageUrl;
    providerArgs.duration = 5;
    providerArgs.resolution = "720p";
  }

  try {
    const submitted = await port.submitJob({ modelPath: opts.modelPath, args: providerArgs });
    // Day-1 fix (edge #12): never silently lose a provider job id — the
    // provider may have started a billable job. Retry persistence; if it
    // still fails, stash the id in the row + audit trail (recovery in
    // runDueAdJobs adopts it) instead of dropping it.
    const persisted = await persistSubmittedJob(db, creativeId, submitted.requestId, creative.attempts);
    if (!persisted) {
      const stash = `providerJobId=${submitted.requestId} submit-ack-not-persisted`;
      try {
        await db.adCreative.update({ where: { id: creativeId }, data: { error: stash } });
      } catch {
        // Persistence is already known-bad; the audit + thrown error below
        // still carry the id.
      }
      const msg =
        `Provider accepted the job but its id could not be saved (job id: ${submitted.requestId}). ` +
        `Recorded in the audit log — reconcile in the provider dashboard before resubmitting.`;
      await auditAds(db, workspaceId, creative.projectId, "ad_generation_failed",
        `Ad job id not persisted: ${submitted.requestId} (${creative.name}).`, actor).catch(() => {});
      return { outcome: "failed", error: msg };
    }
    return { outcome: "submitted", requestId: submitted.requestId };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown provider error.";
    const transient = isTransientHiggsfieldError(err);
    const attempts = creative.attempts + 1;
    if (transient && attempts < MAX_SUBMIT_ATTEMPTS) {
      // Day-1 fix (edge #11): the provider call failed BEFORE acknowledging
      // a job, so nothing billable exists — release the claim back to
      // "queued" for retry. Without this the row would sit in "generating"
      // forever (the sweep only resubmits "queued").
      await db.adCreative.update({
        where: { id: creativeId },
        data: { status: "queued", attempts, nextPollAt: new Date(Date.now() + attempts * 60_000), error: message },
      });
      await auditAds(db, workspaceId, creative.projectId, "ad_generation_started", `Generation submit attempt ${attempts} failed (retrying): ${message.slice(0, 160)}`, actor);
      return { outcome: "retrying", error: message };
    }
    await db.adCreative.update({
      where: { id: creativeId },
      data: { attempts, nextPollAt: null, status: "failed", error: message },
    });
    await auditAds(db, workspaceId, creative.projectId, "ad_generation_failed", `Ad generation failed: ${message.slice(0, 160)}`, actor);
    try {
      await emitAlert({
        workspaceId,
        projectId: creative.projectId,
        trigger: "ad_generation_failed",
        severity: "critical",
        title: "Ad generation failed",
        body: message,
        link: `/dashboard/projects/${creative.projectId}/ads`,
        dedupKey: `ad_generation_failed:${creative.id}:${attempts}`,
      });
    } catch {
      // alert failures never break the generation path
    }
    return { outcome: "failed", error: message };
  }
}

// ---------------------------------------------------------------------------
// Polling state machine — idempotent, cron-driven
// ---------------------------------------------------------------------------

export type PollOutcome = "ready" | "pending" | "failed" | "noop" | "no-job";

export async function pollCreative(
  db: Db,
  workspaceId: string,
  creativeId: string,
  port: HiggsfieldPort,
  actor: "user" | "system" = "user",
): Promise<{ outcome: PollOutcome; error?: string }> {
  const creative = await db.adCreative.findUnique({ where: { id: creativeId } });
  if (!creative) throw new AdGuardError("Creative not found.");
  if (creative.status === "ready" || creative.status === "failed" || creative.status === "cancelled") {
    return { outcome: "noop" };
  }
  if (!creative.providerJobId) return { outcome: "no-job" };

  if (creative.attempts >= MAX_POLL_ATTEMPTS) {
    await markFailed(db, workspaceId, creative, `Polling timed out after ${MAX_POLL_ATTEMPTS} attempts.`, actor);
    return { outcome: "failed", error: "Polling timed out." };
  }

  let status;
  try {
    status = await port.getStatus(creative.providerJobId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown provider error.";
    const attempts = creative.attempts + 1;
    if (isTransientHiggsfieldError(err) && attempts < MAX_POLL_ATTEMPTS) {
      await db.adCreative.update({
        where: { id: creativeId },
        data: { attempts, nextPollAt: new Date(Date.now() + POLL_INTERVAL_MS), error: message },
      });
      return { outcome: "pending", error: message };
    }
    await markFailed(db, workspaceId, creative, message, actor);
    return { outcome: "failed", error: message };
  }

  if (status.state === "completed") {
    const assets = status.mediaUrls.map((url, i) => ({ url, variantIndex: i, costCents: 0 }));
    const actual = typeof status.costCents === "number" ? status.costCents : creative.costEstimateCents;
    await db.adCreative.update({
      where: { id: creativeId },
      data: {
        status: "ready",
        assets,
        costActualCents: actual,
        nextPollAt: null,
        error: null,
      },
    });
    if (actual > 0) await recordSpend(db, workspaceId, actual);
    await auditAds(db, workspaceId, creative.projectId, "ad_generation_completed", `Ad creative ready: ${creative.name} ($${(actual / 100).toFixed(2)} actual)`, actor);
    return { outcome: "ready" };
  }
  if (status.state === "failed" || status.state === "cancelled") {
    await markFailed(db, workspaceId, creative, status.error ?? `Provider reported ${status.state}.`, actor);
    return { outcome: "failed", error: status.error };
  }
  // queued / in_progress — keep polling.
  await db.adCreative.update({
    where: { id: creativeId },
    data: { attempts: creative.attempts + 1, nextPollAt: new Date(Date.now() + POLL_INTERVAL_MS), error: null },
  });
  return { outcome: "pending" };
}

async function markFailed(
  db: Db,
  workspaceId: string,
  creative: { id: string; projectId: string; name: string },
  message: string,
  actor: "user" | "system",
): Promise<void> {
  await db.adCreative.update({
    where: { id: creative.id },
    data: { status: "failed", nextPollAt: null, error: message },
  });
  await auditAds(db, workspaceId, creative.projectId, "ad_generation_failed", `Ad creative failed: ${creative.name} — ${message.slice(0, 160)}`, actor);
  try {
    await emitAlert({
      workspaceId,
      projectId: creative.projectId,
      trigger: "ad_generation_failed",
      severity: "critical",
      title: "Ad generation failed",
      body: message,
      link: `/dashboard/projects/${creative.projectId}/ads`,
      dedupKey: `ad_generation_failed:${creative.id}`,
    });
  } catch {
    // alert failures never break the generation path
  }
}

/**
 * Cron sweep: submit queued creatives that never got a job, and poll
 * in-flight ones whose nextPollAt is due. Bounded per run.
 */
export async function runDueAdJobs(
  db: Db,
  portFactory: (workspaceId: string) => Promise<HiggsfieldPort | null>,
  workspaceId?: string,
  limit = 25,
): Promise<{ submitted: number; ready: number; failed: number; pending: number }> {
  const result = { submitted: 0, ready: 0, failed: 0, pending: 0 };
  const due = await db.adCreative.findMany({
    where: {
      status: { in: ["queued", "generating"] },
      nextPollAt: { lte: new Date() },
      ...(workspaceId ? { campaign: { project: { workspaceId } } } : {}),
    },
    orderBy: { nextPollAt: "asc" },
    take: limit,
    include: { campaign: { select: { id: true, projectId: true, project: { select: { workspaceId: true } } } } },
  });

  const ports = new Map<string, HiggsfieldPort | null>();
  for (const creative of due) {
    const wsId = creative.campaign.project.workspaceId;
    let port = ports.get(wsId);
    if (port === undefined) {
      port = (await portFactory(wsId)) ?? null;
      ports.set(wsId, port);
    }
    if (!port) continue; // no key configured — leave queued for a later run
    if (creative.status === "queued" && !creative.providerJobId) {
      const modelPath = creative.type === "video" ? DEFAULT_VIDEO_MODEL : DEFAULT_IMAGE_MODEL;
      const brief = creative.brief as unknown as Partial<AdBrief>;
      const res = await submitJob(db, wsId, creative.id, port, { modelPath }, "system");
      if (res.outcome === "submitted") result.submitted += 1;
      else if (res.outcome === "failed") result.failed += 1;
      else result.pending += 1;
      void brief;
    } else if (creative.status === "generating" && !creative.providerJobId) {
      // Day-1 fix (edge #12): a previous submit was provider-acknowledged but
      // the job id wasn't persisted. Adopt the stashed id so polling and
      // spend tracking can proceed; otherwise the worker died between claim
      // and provider ack — we cannot know whether a billable job was created,
      // so NEVER auto-resubmit (that could double-charge). Surface it as
      // failed with an explicit reconcile instruction instead of stalling
      // silently.
      const adopted = await adoptStashedJobId(db, creative).catch(() => false);
      if (adopted) {
        const res = await pollCreative(db, wsId, creative.id, port, "system");
        if (res.outcome === "ready") result.ready += 1;
        else if (res.outcome === "failed") result.failed += 1;
        else result.pending += 1;
      } else {
        const msg = "Submit was interrupted before the provider acknowledged a job id. " +
          "Check the provider dashboard for a stray job before resubmitting — do not resubmit blindly.";
        await db.adCreative.update({
          where: { id: creative.id },
          data: { status: "failed", nextPollAt: null, error: msg },
        });
        await auditAds(db, wsId, creative.campaign.projectId, "ad_generation_failed",
          `Ad submit interrupted in an unknown state (${creative.id}): ${msg}`, "system").catch(() => {});
        result.failed += 1;
      }
    } else {
      const res = await pollCreative(db, wsId, creative.id, port, "system");
      if (res.outcome === "ready") result.ready += 1;
      else if (res.outcome === "failed") result.failed += 1;
      else result.pending += 1;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Review actions
// ---------------------------------------------------------------------------

export async function approveCreative(
  db: Db,
  workspaceId: string,
  creativeId: string,
  actor: "user" | "system" = "user",
) {
  const creative = await db.adCreative.findUnique({ where: { id: creativeId } });
  if (!creative || creative.status !== "ready") throw new AdGuardError("Only ready creatives can be approved.");
  const updated = await db.adCreative.update({
    where: { id: creativeId },
    data: { approved: true, rejected: false },
  });
  await auditAds(db, workspaceId, creative.projectId, "ad_creative_approved", `Ad creative approved: ${creative.name}`, actor);
  return updated;
}

export async function rejectCreative(
  db: Db,
  workspaceId: string,
  creativeId: string,
  actor: "user" | "system" = "user",
) {
  const creative = await db.adCreative.findUnique({ where: { id: creativeId } });
  if (!creative) throw new AdGuardError("Creative not found.");
  const updated = await db.adCreative.update({
    where: { id: creativeId },
    data: { rejected: true, approved: false },
  });
  await auditAds(db, workspaceId, creative.projectId, "ad_creative_rejected", `Ad creative rejected: ${creative.name}`, actor);
  return updated;
}

export async function cancelCreative(
  db: Db,
  workspaceId: string,
  creativeId: string,
  actor: "user" | "system" = "user",
) {
  const creative = await db.adCreative.findUnique({ where: { id: creativeId } });
  if (!creative) throw new AdGuardError("Creative not found.");
  if (creative.status === "ready") throw new AdGuardError("Ready creatives cannot be cancelled — reject or delete instead.");
  const updated = await db.adCreative.update({
    where: { id: creativeId },
    data: { status: "cancelled", nextPollAt: null },
  });
  await auditAds(db, workspaceId, creative.projectId, "ad_creative_rejected", `Ad generation cancelled: ${creative.name}`, actor);
  return updated;
}

/**
 * Explicit regeneration with a (possibly edited) prompt. The old prompt is
 * preserved in promptHistory. Never triggered automatically.
 */
export async function regenerateCreative(
  db: Db,
  workspaceId: string,
  creativeId: string,
  args: { prompt?: string; port: HiggsfieldPort; modelPath?: string; referenceImageUrl?: string },
  actor: "user" | "system" = "user",
) {
  const creative = await db.adCreative.findUnique({ where: { id: creativeId } });
  if (!creative) throw new AdGuardError("Creative not found.");
  if (creative.status === "generating" || creative.status === "queued") {
    throw new AdGuardError("This creative is still generating — wait for it to finish first.");
  }
  const newPrompt = args.prompt?.trim() || creative.prompt;
  const history = [...((creative.promptHistory as unknown[]) ?? []), { prompt: creative.prompt, at: new Date().toISOString() }];
  await checkCap(db, workspaceId, creative.costEstimateCents);
  const updated = await db.adCreative.update({
    where: { id: creativeId },
    data: {
      prompt: newPrompt,
      promptHistory: history as unknown as Prisma.JsonArray,
      status: "queued",
      providerJobId: null,
      attempts: 0,
      nextPollAt: new Date(),
      error: null,
      assets: [],
      approved: false,
      rejected: false,
      costActualCents: 0,
    },
  });
  await auditAds(db, workspaceId, creative.projectId, "ad_creative_regenerated", `Ad creative regenerated: ${creative.name}`, actor);
  await submitJob(db, workspaceId, creativeId, args.port, {
    modelPath: args.modelPath ?? (updated.type === "video" ? DEFAULT_VIDEO_MODEL : DEFAULT_IMAGE_MODEL),
    referenceImageUrl: args.referenceImageUrl,
  }, actor).catch(() => undefined);
  return updated;
}

// ---------------------------------------------------------------------------
// Distribution — send approved creatives to social (Wave B: Postiz drafts)
// ---------------------------------------------------------------------------

/** Wave B: the M20 Buffer-based social studio is retired. Approved creatives
 * go to Postiz as drafts — a human publishes from Postiz or the Social tab.
 * The creative's finished assets are uploaded to Postiz and attached to the
 * draft, preserving the old flow's media attachment (text-only would be a
 * regression). Upload failures are fail-closed: no silent media drops. */
export async function sendCreativeToSocial(
  db: Db,
  workspaceId: string,
  projectId: string,
  creativeId: string,
  args: { text: string; channelIds: string[]; platformTypes?: Record<string, string> },
  actor: "user" | "system" = "user",
) {
  const creative = await db.adCreative.findUnique({ where: { id: creativeId } });
  if (!creative || creative.projectId !== projectId) throw new AdGuardError("Creative not found.");
  if (!creative.approved || creative.status !== "ready") {
    throw new AdGuardError("Only approved, ready creatives can be sent to social.");
  }
  const assets = (creative.assets ?? []) as { url: string; variantIndex: number }[];
  if (!assets.length) throw new AdGuardError("This creative has no finished assets yet.");
  const text = args.text.trim();
  if (!text) throw new AdGuardError("Post text is required.");
  if (!args.channelIds.length) throw new AdGuardError("Pick at least one Postiz channel.");
  const draft = await queuePostizDraft({
    content: text,
    channelIds: args.channelIds,
    platformTypes: args.platformTypes,
    mediaUrls: assets.map((a) => a.url),
  });
  await auditAds(db, workspaceId, projectId, "ad_sent_to_social", `Ad creative queued as Postiz draft: ${creative.name}`, actor);
  return draft;
}

// ---------------------------------------------------------------------------
// Spend rollups
// ---------------------------------------------------------------------------

export async function getCampaignSpend(db: Db, campaignId: string): Promise<{ estimated: number; actual: number; count: number }> {
  const agg = await db.adCreative.aggregate({
    where: { campaignId },
    _sum: { costEstimateCents: true, costActualCents: true },
    _count: true,
  });
  return {
    estimated: agg._sum.costEstimateCents ?? 0,
    actual: agg._sum.costActualCents ?? 0,
    count: agg._count,
  };
}
