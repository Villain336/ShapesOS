// Marketr — hosted metering service (Phase C, W4).
//
// The UsageEvent ledger is append-only and is the source of truth; Stripe is
// a downstream sink (see ./billing.ts), never consulted here. Self-hosted
// deployments record locally and enforce caps locally with zero Stripe
// dependency.
//
// Concurrency design (see THREAT-MODEL-METERING.md):
//   T1 idempotency — idempotencyKey is UNIQUE; replays return the prior row.
//   T2 cap races — check-and-append runs inside one transaction that opens
//        with SELECT ... FOR UPDATE on the balance row, so concurrent
//        meter() calls for a workspace serialize.
//   T6 rollover — period rollover happens inside the same locked transaction
//        before the charge lands, so a charge can never count twice.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { emitAlert } from "@/lib/alerts/evaluate";
import {
  CREDIT_TABLE_VERSION,
  creditsFor,
  includedCreditsForPlan,
  isMeteredAction,
} from "./credits";

// ── Public contract (consumed by the sibling MCP track — keep stable) ────────
// Phase C gaps (G1) additions — all back-compatible:
//   MeterOptions.keyId?: string | null — MCP API key id / OAuth client id the
//     charge is attributed to. Server-validated: must belong to an
//     mcpApiKey or mcpOAuthClient in `workspaceId`, else meter() throws (T8).
//     The MCP track passes ctx.credential.keyId (api_key) / clientId (oauth).
//   UsageSummary.byKey?: Record<string, number> — keyId → credits in scope,
//     present only when getUsageSummary() is called WITHOUT a keyId filter.
//   CapStatus += { used, autoOverage } — `allowed` is false only when the
//     hard cap blocks (blockAtCap && !autoOverage && remaining <= 0).
//   setSpendCap() accepts { autoOverage?: boolean } — the explicit opt-in
//     the billing track flips; default stays false (hard cap is the default).

export interface MeterOptions {
  workspaceId: string;
  projectId?: string | null;
  /** Null = system/scheduler actor. Recorded as evidence only. */
  actorId?: string | null;
  /**
   * Phase C gaps (G1): MCP credential this charge is attributed to —
   * the McpApiKey id or McpOAuthClient clientId from the MCP server's own
   * auth context. Null for non-MCP charges. Validated to the workspace (T8).
   */
  keyId?: string | null;
  /** Key into CREDIT_COSTS (v1). */
  action: string;
  /** Caller-supplied idempotency key; must be unique per charge. */
  idempotencyKey: string;
  /** Unverified human pointer for disputes — never authoritative (T7). */
  evidenceRef?: string | null;
  /**
   * Optional composite total in credits (integer >= 0). Used by the
   * scheduler for run totals (base + subagent spawns + actions). When
   * omitted, the credit-table cost for `action` is charged. The action must
   * still be a known key — the override changes the amount, never the
   * meaning.
   */
  credits?: number;
}

export type MeterResult =
  | { ok: true; charged: number; eventId: string }
  | { ok: false; reason: "cap_exceeded" | "unknown_action"; charged: 0; message: string };

export interface UsageSummary {
  used: number;
  included: number;
  purchased: number;
  remaining: number;
  byAction: Record<string, number>;
  byProject: Record<string, number>;
  /**
   * Phase C gaps (G1): keyId → credits in scope. Present only when
   * getUsageSummary() is called WITHOUT a keyId filter. Null keyId rows
   * (non-MCP charges) aggregate under the "direct" bucket.
   */
  byKey?: Record<string, number>;
  periodStart: string;
}

export interface CapStatus {
  /** Advisory: whether a minimal charge would pass. meter() is authoritative. */
  allowed: boolean;
  remaining: number;
  capCredits: number;
  /** Credits used in the current period (for plain-language messaging). */
  used: number;
  /** True when the workspace opted into automatic overage (never the default). */
  autoOverage: boolean;
}

// ── Internals ────────────────────────────────────────────────────────────────

type Tx = Prisma.TransactionClient;

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function monthStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, n: number): Date {
  const c = new Date(d);
  c.setMonth(c.getMonth() + n);
  return c;
}

interface LockedBalance {
  includedCredits: number;
  purchasedCredits: number;
  purchasedExpiresAt: Date | null;
  usedCredits: number;
  periodStart: Date;
}

interface LockedCap {
  capCredits: number;
  blockAtCap: boolean;
  alertAtPct: number;
  lastAlertAt: Date | null;
  autoOverage: boolean;
}

/**
 * Lock the workspace's balance row (creating it from the plan tier on first
 * use). Concurrent meter() calls for one workspace serialize on this lock.
 */
async function lockBalance(tx: Tx, workspaceId: string): Promise<LockedBalance> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const rows = await tx.$queryRaw<LockedBalance[]>`
      SELECT included_credits AS "includedCredits",
             purchased_credits AS "purchasedCredits",
             purchased_expires_at AS "purchasedExpiresAt",
             used_credits AS "usedCredits",
             period_start AS "periodStart"
      FROM credit_balances WHERE workspace_id = ${workspaceId} FOR UPDATE`;
    if (rows.length > 0) return rows[0];
    const ws = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true } });
    if (!ws) throw new Error(`metering: unknown workspace ${workspaceId}`);
    try {
      await tx.creditBalance.create({
        data: {
          workspaceId,
          includedCredits: includedCreditsForPlan(ws.plan),
          purchasedCredits: 0,
          usedCredits: 0,
          periodStart: monthStart(new Date()),
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) continue; // lost the create race — re-lock
      throw err;
    }
  }
  throw new Error("metering: could not lock credit balance");
}

async function lockSpendCap(tx: Tx, workspaceId: string, pool: number): Promise<LockedCap> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const rows = await tx.$queryRaw<LockedCap[]>`
      SELECT cap_credits AS "capCredits", block_at_cap AS "blockAtCap",
             alert_at_pct AS "alertAtPct", last_alert_at AS "lastAlertAt",
             auto_overage AS "autoOverage"
      FROM spend_caps WHERE workspace_id = ${workspaceId} FOR UPDATE`;
    if (rows.length > 0) return rows[0];
    try {
      await tx.spendCap.create({
        data: { workspaceId, capCredits: pool, blockAtCap: true, alertAtPct: 80 },
      });
    } catch (err) {
      if (isUniqueViolation(err)) continue;
      throw err;
    }
  }
  throw new Error("metering: could not lock spend cap");
}

// ── meter() ──────────────────────────────────────────────────────────────────

/**
 * Charge `action` to the workspace's credit pool.
 *
 * Order: validate action → idempotency replay check → lock balance+cap →
 * period rollover → cap check → append event + bump balance → (after commit)
 * 80% alert once per period. Zero-cost actions always pass the cap check.
 */
export async function meter(opts: MeterOptions): Promise<MeterResult> {
  const {
    workspaceId,
    projectId = null,
    actorId = null,
    keyId = null,
    action,
    idempotencyKey,
    evidenceRef = null,
  } = opts;
  if (!workspaceId) throw new Error("metering: workspaceId is required");
  if (!idempotencyKey) throw new Error("metering: idempotencyKey is required");

  if (!isMeteredAction(action)) {
    return {
      ok: false,
      reason: "unknown_action",
      charged: 0,
      message: `Unknown metered action "${action}" (credit table v${CREDIT_TABLE_VERSION}).`,
    };
  }
  let charge = creditsFor(action);
  if (opts.credits !== undefined) {
    if (!Number.isInteger(opts.credits) || opts.credits < 0) {
      throw new Error("metering: credits override must be a non-negative integer");
    }
    charge = opts.credits;
  }

  try {
    const txOut = await prisma.$transaction(
      async (tx): Promise<{ result: MeterResult; alert: { used: number; capCredits: number; alertAtPct: number; periodKey: string } | null }> => {
        // T1: idempotency first — a replay returns the prior result, no re-charge.
        const prior = await tx.usageEvent.findUnique({ where: { idempotencyKey } });
        if (prior) {
          if (prior.workspaceId !== workspaceId) {
            // T1/T3: a key minted in another workspace is rejected, never honored.
            throw new Error("metering: idempotency key belongs to a different workspace");
          }
          return { result: { ok: true, charged: prior.credits, eventId: prior.id }, alert: null };
        }

        // T3: a project ID from another workspace cannot be attached here.
        if (projectId) {
          const proj = await tx.project.findFirst({
            where: { id: projectId, workspaceId },
            select: { id: true },
          });
          if (!proj) throw new Error("metering: project does not belong to workspace");
        }

        // T8: a keyId from another workspace (or a made-up one) is rejected,
        // never stored. The only trusted source is the MCP server's own auth
        // context; meter() re-validates the workspace binding here.
        if (keyId) {
          const [apiKey, oauthClient] = await Promise.all([
            tx.mcpApiKey.findFirst({ where: { id: keyId, workspaceId }, select: { id: true } }),
            tx.mcpOAuthClient.findFirst({ where: { clientId: keyId, workspaceId }, select: { clientId: true } }),
          ]);
          if (!apiKey && !oauthClient) {
            throw new Error("metering: keyId does not belong to workspace");
          }
        }

        // T2: lock balance + cap — concurrent meter() calls serialize here.
        const bal = await lockBalance(tx, workspaceId);
        const cap = await lockSpendCap(tx, workspaceId, bal.includedCredits + bal.purchasedCredits);

        // T6: lazy period rollover inside the locked transaction, before charging.
        const now = new Date();
        let { periodStart, usedCredits, includedCredits, purchasedCredits, purchasedExpiresAt } = bal;
        let rolled = false;
        while (now >= addMonths(periodStart, 1)) {
          periodStart = addMonths(periodStart, 1);
          rolled = true;
        }
        if (rolled) {
          usedCredits = 0;
          if (purchasedExpiresAt && now > purchasedExpiresAt) {
            purchasedCredits = 0;
            purchasedExpiresAt = null;
          }
          await tx.creditBalance.update({
            where: { workspaceId },
            data: { periodStart, usedCredits, purchasedCredits, purchasedExpiresAt },
          });
        }

        // Cap check FIRST. Zero-cost actions always pass — never punish the outcome.
        // Auto-overage (explicit opt-in) also passes: the billing track bills
        // the overage; the ledger records it honestly.
        const overageAllowed = cap.autoOverage || !cap.blockAtCap;
        if (charge > 0 && !overageAllowed && usedCredits + charge > cap.capCredits) {
          return {
            result: {
              ok: false,
              reason: "cap_exceeded",
              charged: 0,
              message:
                `Credit cap reached (${usedCredits.toLocaleString()} of ${cap.capCredits.toLocaleString()} ` +
                `credits used). Raise the cap or add credits in Settings → Usage.`,
            },
            alert: null,
          };
        }

        // Append the immutable event, then bump the balance — same transaction.
        // Overage accrual (invoicing track): the portion of this charge that
        // fell beyond the PAID pool (included + purchased) is marked factually
        // here — but ONLY when the workspace has auto-overage ON. Legacy
        // blockAtCap=false usage is uncapped but unbilled: it accrues no
        // overage, so it can never be invoiced. The hard cap still blocks
        // when it applies (returned above). The invoice cron sums
        // overageCredits per month. Note this is measured against the paid
        // pool, not cap.capCredits — an admin may raise the cap above the
        // pool, but only the pool is pre-paid. Capped to the charge so an
        // event fully beyond the pool marks exactly its own credits.
        const paidPool = includedCredits + purchasedCredits;
        const overageCredits =
          cap.autoOverage && charge > 0
            ? Math.max(0, Math.min(charge, usedCredits + charge - paidPool))
            : 0;
        const event = await tx.usageEvent.create({
          data: {
            workspaceId,
            projectId,
            actorId,
            keyId,
            action,
            credits: charge,
            overageCredits,
            idempotencyKey,
            evidenceRef,
          },
          select: { id: true },
        });
        if (charge > 0) {
          await tx.creditBalance.update({
            where: { workspaceId },
            data: { usedCredits: { increment: charge } },
          });
          usedCredits += charge;
        }

        // 80% alert, once per period. Armed when lastAlertAt predates the period.
        let alert: { used: number; capCredits: number; alertAtPct: number; periodKey: string } | null = null;
        const threshold = Math.floor((cap.capCredits * cap.alertAtPct) / 100);
        const armed = !cap.lastAlertAt || cap.lastAlertAt < periodStart;
        if (charge > 0 && usedCredits >= threshold && armed) {
          await tx.spendCap.update({ where: { workspaceId }, data: { lastAlertAt: now } });
          alert = {
            used: usedCredits,
            capCredits: cap.capCredits,
            alertAtPct: cap.alertAtPct,
            periodKey: periodStart.toISOString().slice(0, 10),
          };
        }

        return { result: { ok: true, charged: charge, eventId: event.id }, alert };
      },
      { maxWait: 10000, timeout: 30000 },
    );

    // Fire the alert AFTER commit — alert delivery never blocks or breaks metering.
    if (txOut.alert) {
      const a = txOut.alert;
      const pct = Math.round((a.used / Math.max(1, a.capCredits)) * 100);
      await emitAlert({
        workspaceId,
        trigger: "metering_cap_warning",
        severity: "warn",
        title: `Credit usage at ${pct}% of cap`,
        body:
          `${a.used.toLocaleString()} of ${a.capCredits.toLocaleString()} credits used this period. ` +
          `Add credits or raise the cap in Settings → Usage to avoid blocked actions.`,
        link: "/dashboard/settings/usage",
        dedupKey: `metering_cap_warning:${workspaceId}:${a.periodKey}`,
      }).catch(() => {
        // Alert delivery is best-effort; the charge already committed.
      });
    }
    return txOut.result;
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Lost the idempotency race: the winner's row is the single charge (T1).
      const winner = await prisma.usageEvent.findUnique({ where: { idempotencyKey } });
      if (winner && winner.workspaceId === workspaceId) {
        return { ok: true, charged: winner.credits, eventId: winner.id };
      }
    }
    throw err;
  }
}

// ── checkCap() ───────────────────────────────────────────────────────────────

/**
 * Advisory cap status. meter() remains the authoritative per-charge check.
 * `allowed` is false only when the hard cap blocks: blockAtCap is on, no
 * auto-overage opt-in, and nothing remains. The scheduler's pre-run gate
 * uses this; the TOCTOU between gate and charge is closed by meter() (T9).
 */
export async function checkCap(workspaceId: string): Promise<CapStatus> {
  const [bal, cap] = await Promise.all([
    prisma.creditBalance.findUnique({ where: { workspaceId } }),
    prisma.spendCap.findUnique({ where: { workspaceId } }),
  ]);
  let included = bal?.includedCredits ?? 0;
  if (!bal) {
    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true } });
    included = includedCreditsForPlan(ws?.plan ?? "self_hosted");
  }
  const purchased = bal?.purchasedCredits ?? 0;
  const used = bal?.usedCredits ?? 0;
  const capCredits = cap?.capCredits ?? included + purchased;
  const blockAtCap = cap?.blockAtCap ?? true;
  const autoOverage = cap?.autoOverage ?? false;
  const remaining = Math.max(0, capCredits - used);
  return {
    allowed: !blockAtCap || autoOverage || remaining > 0,
    remaining,
    capCredits,
    used,
    autoOverage,
  };
}

// ── getUsageSummary() ────────────────────────────────────────────────────────

/**
 * Usage dashboard data. Aggregated from the immutable ledger (not the
 * counter) so the dashboard and the cap always reconcile.
 */
export async function getUsageSummary(opts: {
  workspaceId: string;
  projectId?: string;
  periodStart?: string | Date;
  /** Phase C gaps (G1): restrict to one MCP key / OAuth client. */
  keyId?: string;
}): Promise<UsageSummary> {
  const { workspaceId } = opts;
  const bal = await prisma.creditBalance.findUnique({ where: { workspaceId } });
  let included = bal?.includedCredits ?? 0;
  if (!bal) {
    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true } });
    included = includedCreditsForPlan(ws?.plan ?? "self_hosted");
  }
  const purchased = bal?.purchasedCredits ?? 0;
  const start = opts.periodStart ? new Date(opts.periodStart) : (bal?.periodStart ?? monthStart(new Date()));
  const where: Prisma.UsageEventWhereInput = {
    workspaceId,
    occurredAt: { gte: start },
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.keyId ? { keyId: opts.keyId } : {}),
  };
  const [byActionRows, byProjectRows, byKeyRows] = await Promise.all([
    prisma.usageEvent.groupBy({ by: ["action"], where, _sum: { credits: true } }),
    prisma.usageEvent.groupBy({ by: ["projectId"], where, _sum: { credits: true } }),
    // byKey only when unfiltered (contract: sibling MCP track).
    opts.keyId
      ? Promise.resolve([])
      : prisma.usageEvent.groupBy({ by: ["keyId"], where, _sum: { credits: true } }),
  ]);
  const byAction: Record<string, number> = {};
  const byProject: Record<string, number> = {};
  let used = 0;
  for (const r of byActionRows) {
    const c = r._sum.credits ?? 0;
    byAction[r.action] = c;
    used += c;
  }
  for (const r of byProjectRows) {
    byProject[r.projectId ?? "workspace"] = r._sum.credits ?? 0;
  }
  const summary: UsageSummary = {
    used,
    included,
    purchased,
    remaining: Math.max(0, included + purchased - used),
    byAction,
    byProject,
    periodStart: start.toISOString(),
  };
  if (!opts.keyId) {
    // Null keyId = non-MCP charges; surfaced as the "direct" bucket.
    const byKey: Record<string, number> = {};
    for (const r of byKeyRows) {
      byKey[r.keyId ?? "direct"] = r._sum.credits ?? 0;
    }
    summary.byKey = byKey;
  }
  return summary;
}

// ── Admin operations ─────────────────────────────────────────────────────────

/**
 * Apply a top-up purchase: extends purchased credits (12-month rollover) and
 * raises the cap by the same amount. The BillingSink decides payment; this
 * applies the ledger side inside a locked transaction.
 */
export async function applyTopUp(
  workspaceId: string,
  topUp: { creditsAdded: number; expiresAt: Date },
): Promise<{ purchasedCredits: number; capCredits: number }> {
  if (!Number.isInteger(topUp.creditsAdded) || topUp.creditsAdded <= 0) {
    throw new Error("top-up credits must be a positive integer");
  }
  return prisma.$transaction(async (tx) => {
    const bal = await lockBalance(tx, workspaceId);
    const cap = await lockSpendCap(tx, workspaceId, bal.includedCredits + bal.purchasedCredits);
    const purchasedExpiresAt =
      bal.purchasedExpiresAt && bal.purchasedExpiresAt > topUp.expiresAt
        ? bal.purchasedExpiresAt
        : topUp.expiresAt;
    const purchasedCredits = bal.purchasedCredits + topUp.creditsAdded;
    await tx.creditBalance.update({
      where: { workspaceId },
      data: { purchasedCredits, purchasedExpiresAt },
    });
    const capCredits = cap.capCredits + topUp.creditsAdded;
    await tx.spendCap.update({ where: { workspaceId }, data: { capCredits } });
    return { purchasedCredits, capCredits };
  });
}

/**
 * Admin spend-cap management. Overage stays opt-in: setting blockAtCap false
 * is the legacy explicit opt-out; the Phase C gaps (G1) `autoOverage` flag is
 * the explicit opt-in the billing track flips. Either allows over-cap
 * charges; both default to the hard cap. Audit-logged by the caller.
 */
export async function setSpendCap(
  workspaceId: string,
  patch: { capCredits?: number; blockAtCap?: boolean; alertAtPct?: number; autoOverage?: boolean },
): Promise<LockedCap> {
  if (patch.capCredits !== undefined && (!Number.isInteger(patch.capCredits) || patch.capCredits < 0)) {
    throw new Error("capCredits must be a non-negative integer");
  }
  if (patch.alertAtPct !== undefined && (!Number.isInteger(patch.alertAtPct) || patch.alertAtPct < 1 || patch.alertAtPct > 100)) {
    throw new Error("alertAtPct must be an integer 1–100");
  }
  return prisma.$transaction(async (tx) => {
    const bal = await lockBalance(tx, workspaceId);
    const cap = await lockSpendCap(tx, workspaceId, bal.includedCredits + bal.purchasedCredits);
    const data: { capCredits?: number; blockAtCap?: boolean; alertAtPct?: number; autoOverage?: boolean } = {};
    if (patch.capCredits !== undefined) data.capCredits = patch.capCredits;
    if (patch.blockAtCap !== undefined) data.blockAtCap = patch.blockAtCap;
    if (patch.alertAtPct !== undefined) data.alertAtPct = patch.alertAtPct;
    if (patch.autoOverage !== undefined) data.autoOverage = patch.autoOverage;
    if (Object.keys(data).length > 0) {
      await tx.spendCap.update({ where: { workspaceId }, data });
    }
    return { ...cap, ...data } as LockedCap;
  });
}
