// Marketr — R6 enrichment waterfall (lib/enrichment/waterfall.ts).
//
// Ordered provider chain with stop-at-first-hit. Every attempt — hit, miss,
// error, or skip — writes an EnrichmentLookup row (the audit trail + cost
// accounting), meters one `enrichment_lookup` charge, and audit-logs.
//
// Cost-estimate pattern mirrors lib/seo/backlinks-cost.ts (M15): a pure
// estimateRunCost() the UI shows BEFORE the user confirms a large run, a
// hard per-run cap, and a budget check that fails closed on bad numbers.

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { meter } from "@/lib/metering/service";
import { auditEvent } from "@/lib/auditlog";
import type { FileChangeAction } from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  getEnrichmentProviders,
  type EnrichmentProvider,
} from "./provider";

// ---------------------------------------------------------------------------
// Pricing (estimates — re-verify against each provider's pricing page).
// ---------------------------------------------------------------------------

/** Estimated vendor cost per lookup attempt, USD. Fake costs nothing. */
export const ENRICHMENT_PRICING_USD: Record<string, number> = {
  fake: 0,
  // Apollo bills in Apollo credits (1–9 per matched person), not dollars;
  // $0.05 is a planning estimate for one matched lookup on a typical plan.
  apollo: 0.05,
  // Hunter bills in Hunter credits (1 per email-finder request); $0.02 is a
  // planning estimate on a typical paid plan.
  hunter: 0.02,
};

/** Above this many prospects, /api/enrichment/run requires an estimate ack. */
export const REQUIRE_ESTIMATE_ACK_ABOVE = 100;

/** Hard ceiling on prospects per run — enforced in the run path, not just UI. */
export const MAX_PROSPECTS_PER_RUN = 5_000;

/** Score bump applied when a provider returns a hit. */
export const ENRICHMENT_HIT_SCORE_BONUS = 25;

/** Semantic audit actions. NOTE: these must be added to the FileChangeAction
 *  enum in prisma/schema.prisma by the schema coordinator — until then
 *  auditEvent() no-ops on them (its catch swallows the invalid-enum error).
 *  The calls below are written with the correct intent so no code changes are
 *  needed once the enum lands. */
const AUDIT = {
  runStarted: "prospecting_run_started",
  lookup: "enrichment_lookup",
  runFinished: "prospecting_run_finished",
} as const;

function auditAction(name: string): FileChangeAction {
  return name as FileChangeAction;
}

export interface RunCostEstimate {
  prospectCount: number;
  providerChain: string[];
  /** Worst-case USD per prospect (every provider attempted). */
  perProspectUsd: number;
  /** Worst-case USD for the whole run. */
  estimatedTotalUsd: number;
  /** True when the run needs an explicit estimate ack (>100 prospects). */
  requiresAck: boolean;
  breakdown: Array<{ provider: string; perLookupUsd: number }>;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Cost preview for a waterfall run over `prospectCount` prospects.
 * Pure function — safe to call anywhere (previews, tests).
 * Worst case: every prospect misses every provider except the last.
 */
export function estimateRunCost(
  _workspaceId: string,
  prospectCount: number,
  providerNames?: string[],
): RunCostEstimate {
  const chain = providerNames ?? ["fake"];
  const sane = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  const count = sane(prospectCount) ? Math.max(0, Math.min(Math.floor(prospectCount), MAX_PROSPECTS_PER_RUN)) : 0;
  const breakdown = chain.map((provider) => ({
    provider,
    perLookupUsd: ENRICHMENT_PRICING_USD[provider] ?? 0,
  }));
  const perProspectUsd = round4(breakdown.reduce((s, b) => s + b.perLookupUsd, 0));
  return {
    prospectCount: count,
    providerChain: chain,
    perProspectUsd,
    estimatedTotalUsd: round4(perProspectUsd * count),
    requiresAck: count > REQUIRE_ESTIMATE_ACK_ABOVE,
    breakdown,
  };
}

export interface RunBudgetCheck {
  ok: boolean;
  blockedReason: string | null;
  estimate: RunCostEstimate;
}

/**
 * Pure cost-gate decision for an enrichment run. Called BEFORE any provider
 * call; fails closed on non-numeric input (mirrors checkPullBudget).
 */
export function checkRunBudget(
  workspaceId: string,
  prospectCount: number,
  providerNames: string[] | undefined,
  estimateAck: boolean,
): RunBudgetCheck {
  const estimate = estimateRunCost(workspaceId, prospectCount, providerNames);
  if (estimate.prospectCount <= 0) {
    return { ok: false, blockedReason: "No prospects to enrich.", estimate };
  }
  if (prospectCount > MAX_PROSPECTS_PER_RUN) {
    return {
      ok: false,
      blockedReason: `Requested ${prospectCount.toLocaleString()} prospects exceeds the per-run limit of ${MAX_PROSPECTS_PER_RUN.toLocaleString()}. Split the list and try again.`,
      estimate,
    };
  }
  if (estimate.requiresAck && !estimateAck) {
    return {
      ok: false,
      blockedReason: `This run covers ${estimate.prospectCount} prospects (est. $${estimate.estimatedTotalUsd.toFixed(2)} worst case). Confirm the estimate to proceed.`,
      estimate,
    };
  }
  return { ok: true, blockedReason: null, estimate };
}

// ---------------------------------------------------------------------------
// Waterfall runner.
// ---------------------------------------------------------------------------

export interface WaterfallAttempt {
  provider: string;
  status: "hit" | "miss" | "error" | "skipped";
  costCents: number;
  metered: boolean;
}

export interface WaterfallResult {
  prospectId: string;
  status: "enriched" | "failed";
  hitProvider: string | null;
  attempts: WaterfallAttempt[];
}

/**
 * Run the enrichment waterfall for one prospect. Ordered chain,
 * stop-at-first-hit. Throws when the prospect doesn't exist or belongs to a
 * different workspace.
 */
export async function runWaterfall(
  workspaceId: string,
  prospectId: string,
  providers?: EnrichmentProvider[],
  actorUserId?: string,
): Promise<WaterfallResult> {
  const prospect = await prisma.prospect.findFirst({
    where: { id: prospectId, workspaceId },
    select: { id: true, email: true, phone: true, company: true, website: true, name: true, enrichmentData: true, score: true },
  });
  if (!prospect) throw new Error("Prospect not found");

  const chain = providers ?? getEnrichmentProviders();
  const runId = randomUUID();
  const attempts: WaterfallAttempt[] = [];

  await prisma.prospect.update({
    where: { id: prospect.id },
    data: { status: "enriching" },
  });
  await auditEvent({
    projectId: null,
    workspaceId,
    action: auditAction(AUDIT.runStarted),
    summary: `Enrichment waterfall started for prospect ${prospect.id} (chain: ${chain.map((p) => p.name).join(" → ")})`,
    actorUserId,
  }).catch(() => {});

  let hitProvider: string | null = null;

  for (const provider of chain) {
    const attempt: WaterfallAttempt = { provider: provider.name, status: "miss", costCents: 0, metered: false };
    try {
      const result = await provider.lookup({
        email: prospect.email ?? undefined,
        phone: prospect.phone ?? undefined,
        company: prospect.company ?? undefined,
        website: prospect.website ?? undefined,
        name: prospect.name ?? undefined,
      });

      const metered = await meter({
        workspaceId,
        actorId: actorUserId ?? null,
        action: "enrichment_lookup",
        idempotencyKey: `enrich:${runId}:${provider.name}`,
        evidenceRef: `prospect:${prospect.id}`,
      }).catch(() => null);
      attempt.metered = metered?.ok === true;
      attempt.costCents = result.costCents;

      if (result.hit) {
        attempt.status = "hit";
        await prisma.enrichmentLookup.create({
          data: {
            workspaceId,
            prospectId: prospect.id,
            provider: provider.name,
            status: "hit",
            costCents: result.costCents,
            result: (result.raw ?? {
              company: result.company ?? null,
              contact: result.contact ?? null,
            }) as object,
          },
        });
        await auditEvent({
          projectId: null,
          workspaceId,
          action: auditAction(AUDIT.lookup),
          summary: `Enrichment hit via ${provider.name} for prospect ${prospect.id}${result.company?.name ? ` (${result.company.name})` : ""}`,
          actorUserId,
        }).catch(() => {});

        const prev = (prospect.enrichmentData ?? {}) as Record<string, unknown>;
        const prevCompanies = Array.isArray(prev.companies) ? prev.companies : [];
        const merged = {
          ...prev,
          providers: [...new Set([...((prev.providers as string[]) ?? []), provider.name])],
          company: { ...((prev.company as object) ?? {}), ...(result.company ?? {}) },
          contact: { ...((prev.contact as object) ?? {}), ...(result.contact ?? {}) },
          companies: result.company ? [...prevCompanies, result.company] : prevCompanies,
          lastEnrichedAt: new Date().toISOString(),
          lastHitProvider: provider.name,
        };
        await prisma.prospect.update({
          where: { id: prospect.id },
          data: {
            enrichmentData: merged as object,
            status: "enriched",
            score: Math.min(100, prospect.score + ENRICHMENT_HIT_SCORE_BONUS),
          },
        });
        hitProvider = provider.name;
        attempts.push(attempt);
        break; // stop-at-first-hit
      }

      await prisma.enrichmentLookup.create({
        data: {
          workspaceId,
          prospectId: prospect.id,
          provider: provider.name,
          status: "miss",
          costCents: result.costCents,
          result: (result.raw ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue,
        },
      });
      await auditEvent({
        projectId: null,
        workspaceId,
        action: auditAction(AUDIT.lookup),
        summary: `Enrichment miss via ${provider.name} for prospect ${prospect.id}`,
        actorUserId,
      }).catch(() => {});
      attempts.push(attempt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      attempt.status = "error";
      await prisma.enrichmentLookup.create({
        data: {
          workspaceId,
          prospectId: prospect.id,
          provider: provider.name,
          status: "error",
          costCents: 0,
          error: message.slice(0, 500),
        },
      });
      await auditEvent({
        projectId: null,
        workspaceId,
        action: auditAction(AUDIT.lookup),
        summary: `Enrichment error via ${provider.name} for prospect ${prospect.id}: ${message.slice(0, 200)}`,
        actorUserId,
      }).catch(() => {});
      attempts.push(attempt);
      // Continue to the next provider — one provider's outage must not
      // sink the whole waterfall.
    }
  }

  if (!hitProvider) {
    await prisma.prospect.update({ where: { id: prospect.id }, data: { status: "failed" } });
  }
  await auditEvent({
    projectId: null,
    workspaceId,
    action: auditAction(AUDIT.runFinished),
    summary: `Enrichment waterfall finished for prospect ${prospect.id}: ${hitProvider ? `hit via ${hitProvider}` : "no hit"} (${attempts.length} attempt(s))`,
    actorUserId,
  }).catch(() => {});

  return {
    prospectId: prospect.id,
    status: hitProvider ? "enriched" : "failed",
    hitProvider,
    attempts,
  };
}
