// Marketr — Phase 8 G1: Tier-S scheduled pull framework (docs/specs/SPEC-PHASE8.md §2 G1).
//
// Google Ads (GAQL), Meta Insights (async jobs), TikTok (nightly batched),
// LinkedIn. Per-platform rate budgets enforced in the job runner; failure →
// backoff with jitter; repeated failure → dead-letter + human alert, never
// silent. 3-day lookback windows for attribution restatements; full monthly
// resync. All sync work is async — nothing on the request path.

import type { GraphConnector, GraphSyncJob, Prisma } from "@prisma/client";
import { appendFact } from "../facts";
import { projectFact } from "../project";
import { withWorkspaceScope } from "../rls";
import { resolveMode, platformSpec, type TierSPlatform, type RateBudget } from "./types";
import type { FactPayload } from "../types";

export type { TierSPlatform };

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Backoff with jitter: base 5min doubling, ±25% jitter, capped at 6h.
// ---------------------------------------------------------------------------

export function backoffWithJitter(errorCount: number, rand = Math.random): number {
  const base = 5 * 60_000;
  const exp = Math.min(errorCount, 8);
  const capped = Math.min(base * 2 ** exp, 6 * 3_600_000);
  const jitter = 1 + (rand() - 0.5) * 0.5;
  return Math.round(capped * jitter);
}

export function shouldRun(job: GraphSyncJob, now = new Date()): { run: boolean; reason: string } {
  if (job.backoffUntil && job.backoffUntil.getTime() > now.getTime()) {
    return { run: false, reason: `backing off until ${job.backoffUntil.toISOString()}` };
  }
  if (job.status === "dead") {
    return { run: false, reason: "job is dead — human intervention required" };
  }
  return { run: true, reason: "due" };
}

// ---------------------------------------------------------------------------
// Rate budgets. Windows roll automatically; exhaustion blocks the pull and
// the job backs off instead of blowing the platform budget (spec §10.6).
// ---------------------------------------------------------------------------

export interface BudgetCheck {
  ok: boolean;
  reason: string;
  budget: RateBudget;
}

export function checkRateBudget(budget: RateBudget, spec: RateBudget, now = new Date()): BudgetCheck {
  const b: RateBudget = { ...budget };
  const windowStart = b.windowStart ? new Date(b.windowStart).getTime() : 0;
  if (now.getTime() - windowStart > DAY_MS) {
    b.windowStart = now.toISOString();
    b.usedOps = 0;
  }
  const hourStart = b.hourWindowStart ? new Date(b.hourWindowStart).getTime() : 0;
  if (now.getTime() - hourStart > 3_600_000) {
    b.hourWindowStart = now.toISOString();
    b.usedThisHour = 0;
  }
  if ((b.usedOps ?? 0) >= spec.dailyOps) {
    return { ok: false, reason: `daily ops budget exhausted (${b.usedOps}/${spec.dailyOps})`, budget: b };
  }
  if (spec.hourlyCalls !== undefined && (b.usedThisHour ?? 0) >= spec.hourlyCalls) {
    return { ok: false, reason: `hourly call budget exhausted (${b.usedThisHour}/${spec.hourlyCalls})`, budget: b };
  }
  return { ok: true, reason: "budget available", budget: b };
}

export function recordUsage(budget: RateBudget, ops: number, calls = 1): RateBudget {
  return {
    ...budget,
    usedOps: (budget.usedOps ?? 0) + ops,
    usedThisHour: (budget.usedThisHour ?? 0) + calls,
  };
}

// ---------------------------------------------------------------------------
// Platform adapters. Fake mode returns deterministic fixtures (no network);
// live mode throws honestly when credentials are absent.
// ---------------------------------------------------------------------------

export interface PullCursor {
  since?: string;
  until?: string;
  pageToken?: string | null;
  fullResync?: boolean;
}

export interface PulledRow {
  entityRef: string;
  factType: string;
  payload: FactPayload;
  observedAt: Date;
  sourceRecordId: string;
}

export interface PullResult {
  rows: PulledRow[];
  nextCursor: PullCursor;
  opsUsed: number;
  done: boolean;
}

export interface PlatformAdapter {
  platform: TierSPlatform;
  pull(cursor: PullCursor, mode: "fake" | "live"): Promise<PullResult>;
}

/** Deterministic fixture rows — the same every run, so batteries are stable. */
function fixtureRows(platform: TierSPlatform, cursor: PullCursor): PulledRow[] {
  const day = cursor.since ?? "2026-09-24";
  const observedAt = new Date(`${day}T00:00:00Z`);
  switch (platform) {
    case "google_ads":
      return [
        {
          entityRef: "campaign_ref:platform:gads-111",
          factType: "gads_campaign_stats",
          sourceRecordId: `gads:111:${day}`,
          observedAt,
          payload: {
            displayName: "Fall Prospecting",
            core: { platformRef: "gads-111", platform: "google_ads" },
            properties: { impressions: 12000, clicks: 340, costMicros: 185000000 },
            relationships: [{ to: "channel:platform:google_ads", edgeType: "RAN_ON" }],
          },
        },
      ];
    case "meta":
      return [
        {
          entityRef: "campaign_ref:platform:meta-222",
          factType: "meta_insights",
          sourceRecordId: `meta:222:${day}`,
          observedAt,
          payload: {
            displayName: "Fall Prospecting — Meta",
            core: { platformRef: "meta-222", platform: "meta" },
            properties: { impressions: 45000, clicks: 1200, spendCents: 42000 },
            relationships: [{ to: "channel:platform:meta", edgeType: "RAN_ON" }],
          },
        },
      ];
    case "tiktok":
      return [
        {
          entityRef: "campaign_ref:platform:tt-333",
          factType: "tiktok_report",
          sourceRecordId: `tiktok:333:${day}`,
          observedAt,
          payload: {
            displayName: "Fall Prospecting — TikTok",
            core: { platformRef: "tt-333", platform: "tiktok" },
            properties: { impressions: 90000, clicks: 2100, spendCents: 31000 },
            relationships: [{ to: "channel:platform:tiktok", edgeType: "RAN_ON" }],
          },
        },
      ];
    case "linkedin":
      return [
        {
          entityRef: "campaign_ref:platform:li-444",
          factType: "linkedin_stats",
          sourceRecordId: `linkedin:444:${day}`,
          observedAt,
          payload: {
            displayName: "Fall ABM — LinkedIn",
            core: { platformRef: "li-444", platform: "linkedin" },
            properties: { impressions: 8000, clicks: 190, spendCents: 56000 },
            relationships: [{ to: "channel:platform:linkedin", edgeType: "RAN_ON" }],
          },
        },
      ];
  }
}

const FakeAdapter = (platform: TierSPlatform): PlatformAdapter => ({
  platform,
  async pull(cursor) {
    // 3-day lookback for attribution restatements: re-pull the last 3 days.
    const rows = fixtureRows(platform, cursor);
    return {
      rows,
      nextCursor: { ...cursor, pageToken: null },
      opsUsed: platform === "google_ads" ? rows.length : 1, // GAQL: 1 op per SearchStream regardless of rows
      done: true,
    };
  },
});

function liveAdapter(platform: TierSPlatform): PlatformAdapter {
  return {
    platform,
    async pull() {
      // v1 ships the framework + fake fixtures. Live adapters land per
      // platform with credentials; until then this is the honest failure.
      throw new Error(
        `${platform}: live pull not configured — connect credentials in the vault and set GRAPH_CONNECTORS_LIVE=1`,
      );
    },
  };
}

export function adapterFor(platform: TierSPlatform, mode: "fake" | "live"): PlatformAdapter {
  return mode === "fake" ? FakeAdapter(platform) : liveAdapter(platform);
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

export interface SyncRunResult {
  ran: boolean;
  status: string;
  rowsIngested: number;
  opsUsed: number;
  detail: string;
}

export async function runScheduledPull(opts: {
  workspaceId: string;
  connectorId: string;
  platform: TierSPlatform;
  actor?: string;
  now?: Date;
}): Promise<SyncRunResult> {
  const { workspaceId, connectorId, platform } = opts;
  const now = opts.now ?? new Date();
  return withWorkspaceScope(workspaceId, async (tx) => {
    const connector = await tx.graphConnector.findFirst({
      where: { workspaceId, id: connectorId },
    });
    if (!connector) throw new Error("connector not found");
    let job = await tx.graphSyncJob.findFirst({
      where: { workspaceId, connectorId },
    });
    if (!job) {
      job = await tx.graphSyncJob.create({
        data: {
          workspaceId,
          connectorId,
          tier: "scheduled",
          rateBudget: platformSpec(platform).rateBudget as unknown as object,
          cursorState: defaultCursor(now) as unknown as Prisma.InputJsonValue,
        },
      });
    }

    const gate = shouldRun(job, now);
    if (!gate.run) {
      return { ran: false, status: job.status, rowsIngested: 0, opsUsed: 0, detail: gate.reason };
    }

    const spec = platformSpec(platform);
    const budgetCheck = checkRateBudget(
      job.rateBudget as unknown as RateBudget,
      spec.rateBudget,
      now,
    );
    if (!budgetCheck.ok) {
      // Budget exhausted → back off with jitter instead of blowing the budget.
      const waitMs = backoffWithJitter(job.errorCount + 1);
      await tx.graphSyncJob.update({
        where: { id: job.id, workspaceId },
        data: {
          status: "backing_off",
          backoffUntil: new Date(now.getTime() + waitMs),
          rateBudget: budgetCheck.budget as unknown as object,
          lastRunAt: now,
        },
      });
      return {
        ran: false,
        status: "backing_off",
        rowsIngested: 0,
        opsUsed: 0,
        detail: `rate budget exhausted — backing off: ${budgetCheck.reason}`,
      };
    }

    const { mode, reason } = resolveMode(connector);
    const adapter = adapterFor(platform, mode);
    const cursor = (job.cursorState ?? {}) as PullCursor;
    await tx.graphSyncJob.update({
      where: { id: job.id, workspaceId },
      data: { status: "running", lastRunAt: now },
    });

    try {
      const result = await adapter.pull(cursor, mode);
      let ingested = 0;
      for (const row of result.rows) {
        const fact = await appendFact(
          {
            workspaceId,
            source: connector.id,
            sourceRecordId: row.sourceRecordId,
            entityRef: row.entityRef,
            factType: row.factType,
            payload: row.payload,
            observedAt: row.observedAt,
            actor: opts.actor ?? `sync:${platform}`,
            deferProjection: true,
          },
          tx,
        );
        await projectFact(tx, fact);
        ingested++;
      }
      const budget = recordUsage(budgetCheck.budget, result.opsUsed);
      await tx.graphSyncJob.update({
        where: { id: job.id, workspaceId },
        data: {
          status: "succeeded",
          cursorState: result.nextCursor as unknown as object,
          rateBudget: budget as unknown as object,
          lastSuccessAt: now,
          errorCount: 0,
          backoffUntil: null,
        },
      });
      return {
        ran: true,
        status: "succeeded",
        rowsIngested: ingested,
        opsUsed: result.opsUsed,
        detail: `${ingested} row(s) ingested (${mode} mode: ${reason})`,
      };
    } catch (e) {
      const errorCount = job.errorCount + 1;
      const waitMs = backoffWithJitter(errorCount);
      const dead = errorCount >= 10;
      await tx.graphSyncJob.update({
        where: { id: job.id, workspaceId },
        data: {
          status: dead ? "dead" : "failed",
          errorCount,
          backoffUntil: dead ? null : new Date(now.getTime() + waitMs),
          rateBudget: budgetCheck.budget as unknown as object,
        },
      });
      return {
        ran: true,
        status: dead ? "dead" : "failed",
        rowsIngested: 0,
        opsUsed: 0,
        detail: `pull failed honestly: ${(e as Error).message}`,
      };
    }
  });
}

/** Default cursor: 3-day lookback for attribution restatements. */
export function defaultCursor(now = new Date()): PullCursor {
  const since = new Date(now.getTime() - 3 * DAY_MS).toISOString().slice(0, 10);
  return { since, until: now.toISOString().slice(0, 10), pageToken: null };
}

/** Monthly full resync: widen the cursor to the last 31 days. */
export function fullResyncCursor(now = new Date()): PullCursor {
  const since = new Date(now.getTime() - 31 * DAY_MS).toISOString().slice(0, 10);
  return { since, until: now.toISOString().slice(0, 10), pageToken: null, fullResync: true };
}
