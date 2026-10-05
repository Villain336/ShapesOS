// ShapesOS — Phase 15.4 (zernio): cost recovery for the Zernio platform key.
//
// Zernio bills ShapesOS per connected account per month (2 free, then $6 /
// $3 / $1 tiers) and for managed ads beyond 500 free per account. The monthly
// pass (POST /api/cron/zernio-accounts, 1st of the month) charges it back:
//
//   connected  = the workspace's ACTIVE, enabled accounts Zernio lists on its
//                profile right now (listAccounts?profileId=; Zernio does not
//                bill `enabled: false` side-effect accounts, neither do we)
//   included   = the plan's ZERNIO_INCLUDED_ACCOUNTS (Agency: one pool for
//                the owner's agency workspaces), never below
//                ZERNIO_FREE_ACCOUNTS_PER_WORKSPACE; self-hosted: all (own key)
//   billable   = max(0, connected − included)
//   charge     = billable × ZERNIO_ACCOUNT_MONTH_CREDITS  (zernio_account_month)
//   + managed-ad overage: Zernio's own `ads` charge for the profile over the
//     previous billing cycle (getUsage metering mode, profileId projection),
//     × ZERNIO_MANAGED_ADS_MARGIN                            (zernio_managed_ads)
//
// Idempotent per (workspace, month): the meter() keys are
// zernio-accounts:<ws>:<YYYY-MM> and zernio-managed-ads:<ws>:<YYYY-MM>, and the
// snapshot row (zernio_account_usage) is written once; a re-run never charges
// twice. A capped workspace is recorded "blocked", an unreadable one "error"
// (never a guess) — both are retried by the next run of the same month.

import type { Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { meter } from "@/lib/metering/service";
import {
  ZERNIO_ACCOUNT_MONTH_CREDITS,
  ZERNIO_FREE_ACCOUNTS_PER_WORKSPACE,
  ZERNIO_MANAGED_ADS_MARGIN,
} from "@/lib/metering/credits";
import { ZERNIO_INCLUDED_ACCOUNTS, ZERNIO_POOLED_PLANS } from "@/lib/billing/entitlements";
import type { ZernioClient } from "./client";
import { getZernioScope, liveProfileAccounts } from "./tenancy";

export function monthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

export interface WorkspaceForAllocation {
  id: string;
  plan: Plan;
  ownerUserId: string;
  createdAt: Date;
  connected: number;
}

/**
 * Included accounts per workspace (PURE). null = unlimited (self-hosted).
 * Pooled plans share one pool per owner, handed out oldest workspace first;
 * every workspace keeps the per-workspace free floor.
 */
export function allocateIncludedAccounts(rows: WorkspaceForAllocation[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const pools = new Map<string, WorkspaceForAllocation[]>();
  for (const w of rows) {
    const planIncluded = (ZERNIO_INCLUDED_ACCOUNTS as Record<string, number | null>)[w.plan];
    if (planIncluded === null) {
      out.set(w.id, null);
      continue;
    }
    if (ZERNIO_POOLED_PLANS.has(w.plan)) {
      const key = `${w.plan}:${w.ownerUserId}`;
      pools.set(key, [...(pools.get(key) ?? []), w]);
      continue;
    }
    out.set(w.id, Math.max(ZERNIO_FREE_ACCOUNTS_PER_WORKSPACE, planIncluded ?? 0));
  }
  for (const group of pools.values()) {
    let left = (ZERNIO_INCLUDED_ACCOUNTS as Record<string, number | null>)[group[0]!.plan] ?? 0;
    const ordered = [...group].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    for (const w of ordered) {
      const take = Math.min(w.connected, left);
      left -= take;
      out.set(w.id, Math.max(ZERNIO_FREE_ACCOUNTS_PER_WORKSPACE, take));
    }
  }
  return out;
}

export function billableAccounts(connected: number, included: number | null): number {
  if (included === null) return 0;
  return Math.max(0, connected - included);
}

export function managedAdsCredits(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.ceil(usd * 100 * ZERNIO_MANAGED_ADS_MARGIN);
}

export interface MeteringRowResult {
  workspaceId: string;
  month: string;
  status: "charged" | "included" | "blocked" | "error" | "already_done" | "no_profile";
  connected?: number;
  included?: number | null;
  billable?: number;
  accountCredits?: number;
  managedAdsUsd?: number;
  managedAdsCredits?: number;
  detail?: string;
}

/**
 * The monthly pass. `client` is the Zernio client (tests pass a FAKE one);
 * `workspaceIds` limits which workspaces are charged (a signed-in run) while
 * pooling still sees the owner's whole group.
 */
export async function runZernioAccountMetering(opts: {
  client: ZernioClient;
  now?: Date;
  workspaceIds?: string[] | null;
}): Promise<{ month: string; results: MeteringRowResult[] }> {
  const now = opts.now ?? new Date();
  const month = monthKey(now);
  const mode = opts.client.mode;
  const all = await prisma.workspace.findMany({ select: { id: true, plan: true, ownerUserId: true, createdAt: true }, orderBy: { createdAt: "asc" } });
  const wanted = opts.workspaceIds ? new Set(opts.workspaceIds) : null;
  const owners = wanted ? new Set(all.filter((w) => wanted.has(w.id)).map((w) => w.ownerUserId)) : null;
  // Pooling needs every workspace of the same owner; charging only the wanted ones.
  const considered = owners ? all.filter((w) => owners.has(w.ownerUserId)) : all;

  const results: MeteringRowResult[] = [];
  const counts = new Map<string, { connected: number; profileId: string } | { error: string }>();
  for (const w of considered) {
    const profile = await withWorkspaceScope(w.id, (tx) => tx.zernioProfile.findUnique({ where: { workspaceId_mode: { workspaceId: w.id, mode } } }));
    if (!profile) continue;
    try {
      const scope = await getZernioScope(w.id, { client: opts.client, create: false });
      const live = await liveProfileAccounts(scope);
      counts.set(w.id, { connected: live.filter((a) => a.isActive && a.enabled !== false).length, profileId: scope.profileId });
    } catch (e) {
      counts.set(w.id, { error: e instanceof Error ? e.message.slice(0, 300) : "unreadable" });
    }
  }
  const included = allocateIncludedAccounts(
    considered
      .filter((w) => counts.has(w.id))
      .map((w) => {
        const c = counts.get(w.id)!;
        return { ...w, connected: "connected" in c ? c.connected : 0 };
      }),
  );

  for (const w of considered) {
    if (wanted && !wanted.has(w.id)) continue;
    const c = counts.get(w.id);
    if (!c) {
      results.push({ workspaceId: w.id, month, status: "no_profile" });
      continue;
    }
    const prior = await withWorkspaceScope(w.id, (tx) => tx.zernioAccountUsage.findUnique({ where: { workspaceId_month: { workspaceId: w.id, month } } }));
    if (prior && (prior.status === "charged" || prior.status === "included")) {
      results.push({ workspaceId: w.id, month, status: "already_done", connected: prior.connectedAccounts, billable: prior.billableAccounts, accountCredits: prior.accountCredits });
      continue;
    }
    if ("error" in c) {
      await writeSnapshot(w.id, month, { connected: 0, included: 0, billable: 0, accountCredits: 0, managedAdsUsd: 0, managedAdsCredits: 0, status: "error", detail: c.error });
      results.push({ workspaceId: w.id, month, status: "error", detail: c.error });
      continue;
    }
    // null = every account included (self-hosted, own key) — not "missing".
    const inc = included.has(w.id) ? (included.get(w.id) as number | null) : ZERNIO_FREE_ACCOUNTS_PER_WORKSPACE;
    const billable = billableAccounts(c.connected, inc);
    const accountCredits = billable * ZERNIO_ACCOUNT_MONTH_CREDITS;

    let managedUsd = 0;
    let managedDetail: string | null = null;
    if (inc !== null) {
      try {
        const usage = await opts.client.getUsageMetering({ range: "prev-cycle", profileId: c.profileId });
        managedUsd = usage.supported === false ? 0 : Number(usage.totals?.ads ?? 0) || 0;
      } catch (e) {
        managedDetail = `managed-ads usage unreadable: ${e instanceof Error ? e.message.slice(0, 200) : "error"}`;
      }
    }
    const adsCredits = managedAdsCredits(managedUsd);

    let status: MeteringRowResult["status"] = billable > 0 || adsCredits > 0 ? "charged" : "included";
    let detail: string | null = managedDetail;
    try {
      if (accountCredits > 0) {
        const r = await meter({
          workspaceId: w.id,
          action: "zernio_account_month",
          credits: accountCredits,
          idempotencyKey: `zernio-accounts:${w.id}:${month}`,
          evidenceRef: `zernio:${month} ${c.connected} connected, ${inc ?? "all"} included, ${billable} billable`,
        });
        if (!r.ok) {
          status = "blocked";
          detail = r.message;
        }
      }
      if (status !== "blocked" && adsCredits > 0) {
        const r = await meter({
          workspaceId: w.id,
          action: "zernio_managed_ads",
          credits: adsCredits,
          idempotencyKey: `zernio-managed-ads:${w.id}:${month}`,
          evidenceRef: `zernio:${month} managed ads $${managedUsd.toFixed(2)} × ${ZERNIO_MANAGED_ADS_MARGIN}`,
        });
        if (!r.ok) {
          status = "blocked";
          detail = r.message;
        }
      }
    } catch (e) {
      status = "error";
      detail = e instanceof Error ? e.message.slice(0, 300) : "metering failed";
    }
    await writeSnapshot(w.id, month, {
      connected: c.connected,
      included: inc ?? c.connected,
      billable,
      accountCredits,
      managedAdsUsd: managedUsd,
      managedAdsCredits: adsCredits,
      status: status as "charged" | "included" | "blocked" | "error",
      detail,
    });
    results.push({
      workspaceId: w.id, month, status, connected: c.connected, included: inc, billable, accountCredits,
      managedAdsUsd: managedUsd, managedAdsCredits: adsCredits, ...(detail ? { detail } : {}),
    });
  }
  return { month, results };
}

async function writeSnapshot(
  workspaceId: string,
  month: string,
  s: {
    connected: number;
    included: number;
    billable: number;
    accountCredits: number;
    managedAdsUsd: number;
    managedAdsCredits: number;
    status: "charged" | "included" | "blocked" | "error";
    detail: string | null;
  },
): Promise<void> {
  const data = {
    connectedAccounts: s.connected,
    includedAccounts: s.included,
    billableAccounts: s.billable,
    accountCredits: s.accountCredits,
    managedAdsUsd: s.managedAdsUsd,
    managedAdsCredits: s.managedAdsCredits,
    status: s.status,
    detail: s.detail,
  };
  await withWorkspaceScope(workspaceId, (tx) =>
    tx.zernioAccountUsage.upsert({
      where: { workspaceId_month: { workspaceId, month } },
      create: { workspaceId, month, ...data },
      update: data,
    }),
  );
}

/** For the usage page: this workspace's latest snapshots (newest first). */
export async function zernioUsageHistory(workspaceId: string, limit = 6) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.zernioAccountUsage.findMany({ where: { workspaceId }, orderBy: { month: "desc" }, take: limit }),
  );
}
