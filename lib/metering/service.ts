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

import { Prisma, type Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { emitAlert } from "@/lib/alerts/evaluate";
import {
  CREDIT_TABLE_VERSION,
  categoryOf,
  creditsFor,
  includedCreditsForPlan,
  isMeteredAction,
  type CreditCategory,
} from "./credits";
import { BadRequestError } from "@/lib/api/errors";
import { isTrialExpired, trialExpiredMessage } from "@/lib/billing/trial";

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
  /**
   * Phase 7: token usage of one model call (action "llm_tokens", written by
   * lib/llm/usage.ts). Stored on the same append-only event row. costMicroUsd
   * is the estimated vendor cost; null when a price is unknown.
   */
  llm?: LlmUsageFields | null;
  /**
   * Phase 15: whose key paid for the work — "platform" (charged),
   * "workspace" (the workspace's own key: callers pass credits 0) or
   * "self_host" (a local model). Recorded on the row; null = no key choice.
   */
  keySource?: KeySource | null;
  /**
   * Phase 15: credits this event would have cost on the platform key (BYOK
   * savings). Non-negative integer; only meaningful with keySource
   * "workspace".
   */
  waivedCredits?: number;
  /**
   * Phase 15.2: the work ALREADY happened and was paid for (a model call
   * that returned, a call that ended, a sandbox that ran). The charge is
   * recorded even past the cap — the pre-call check (checkCap / the LLM
   * spend gate) is the gate, and refusing here would only hide real usage.
   * Idempotency still applies, so a retried record never charges twice.
   */
  afterTheFact?: boolean;
}

export type KeySource = "platform" | "workspace" | "self_host";
const KEY_SOURCES: ReadonlySet<string> = new Set<KeySource>(["platform", "workspace", "self_host"]);

export interface LlmUsageFields {
  provider: string;
  model: string;
  workload: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicroUsd: number | null;
  // Phase 17 (A1, WS=model): per-call observability — time to first token,
  // wall-clock, the effort sent, whether the prompt cache was read, and the
  // provider's service tier. Optional: every older caller keeps working.
  ttftMs?: number | null;
  durationMs?: number | null;
  effort?: string | null;
  cacheHit?: boolean | null;
  serviceTier?: string | null;
}

function nonNegInt(n: number, field: string): number {
  if (!Number.isInteger(n) || n < 0) throw new Error(`metering: llm.${field} must be a non-negative integer`);
  return n;
}

export type MeterResult =
  | { ok: true; charged: number; eventId: string }
  | {
      ok: false;
      reason: "cap_exceeded" | "unknown_action";
      charged: 0;
      message: string;
      /**
       * Phase 3: set when the refusal is an ended hosted trial (still
       * reason "cap_exceeded", so every existing caller blocks the action
       * the same way). The message carries the upgrade prompt.
       */
      trialExpired?: true;
    };

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
  /** Phase 15.2: credits by category (AI, data, messaging, compute, other). */
  byCategory: Record<CreditCategory, number>;
  /** Phase 15.2: credits the workspace's own model keys saved (BYOK). */
  byokSavedCredits: number;
  /**
   * Phase 15.2: agency credit pooling. Present when this workspace spends an
   * agency pool (as the owner with client workspaces, or as a client):
   * the pool owner, the pool's used credits (all its workspaces), and — for
   * the owner — credits by client workspace.
   */
  pool?: {
    ownerWorkspaceId: string;
    role: "owner" | "member";
    used: number;
    byWorkspace?: Record<string, number>;
  };
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
  /** Phase 3: the workspace's hosted trial is over — metered actions are refused. */
  trialExpired?: boolean;
  /** Phase 15.2: set when the workspace spends an agency pool (the owner's id). */
  poolWorkspaceId?: string;
  /** Phase 15.2: true when the hard cap applies (a charge past `remaining`
   *  would be refused); false for self-hosted / auto-overage / opted-out. */
  hardCap?: boolean;
}

/**
 * Phase 15.2: would a charge of `credits` pass right now? Advisory, like
 * checkCap (meter() is authoritative) — for callers that must check an
 * exact amount BEFORE spending money they can't take back (a mail piece).
 */
export function capFits(cap: CapStatus, credits: number): boolean {
  if (cap.trialExpired) return credits <= 0;
  if (credits <= 0) return true;
  if (!cap.hardCap) return true;
  return cap.remaining >= credits;
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
    // ON CONFLICT DO NOTHING, not create + catch: in Postgres a unique
    // violation aborts the whole transaction, so a caught P2002 could never be
    // retried (every later statement fails "current transaction is aborted").
    // Losing the create race is now a no-op and the loop re-locks the winner's row.
    await tx.$executeRaw`
      INSERT INTO credit_balances (workspace_id, included_credits, purchased_credits, used_credits, period_start)
      VALUES (${workspaceId}, ${includedCreditsForPlan(ws.plan)}, 0, 0, ${monthStart(new Date())})
      ON CONFLICT (workspace_id) DO NOTHING`;
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
    // Self-hosted = BYO provider keys (credits.ts): usage is recorded, never
    // blocked. Every other plan starts with the hard cap at its pool.
    // ON CONFLICT DO NOTHING for the same reason as lockBalance.
    const ws = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true } });
    await tx.$executeRaw`
      INSERT INTO spend_caps (workspace_id, cap_credits, block_at_cap, alert_at_pct, auto_overage)
      VALUES (${workspaceId}, ${pool}, ${ws?.plan !== "self_hosted"}, 80, false)
      ON CONFLICT (workspace_id) DO NOTHING`;
  }
  throw new Error("metering: could not lock spend cap");
}

// ── Agency credit pooling (Phase 15.2) ──────────────────────────────────────

type PoolReader = Pick<Tx, "workspace">;

/**
 * The workspace whose balance + cap a charge for `workspaceId` lands on:
 * the Agency-plan workspace it pools into, else itself. A pointer at a
 * workspace that is no longer on the Agency plan is ignored (fail safe to
 * the workspace's own pool — never another tenant's).
 */
export async function resolvePoolWorkspaceId(db: PoolReader, workspaceId: string): Promise<string> {
  const ws = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { creditPoolOwnerId: true, creditPoolOwner: { select: { id: true, plan: true, creditPoolOwnerId: true } } },
  });
  const owner = ws?.creditPoolOwner;
  // One level only: an owner that itself points somewhere is not a pool.
  if (owner && owner.plan === "agency" && !owner.creditPoolOwnerId) return owner.id;
  return workspaceId;
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
    llm = null,
    keySource = null,
    waivedCredits = 0,
    afterTheFact = false,
  } = opts;
  if (!workspaceId) throw new Error("metering: workspaceId is required");
  if (!idempotencyKey) throw new Error("metering: idempotencyKey is required");
  if (keySource !== null && !KEY_SOURCES.has(keySource)) throw new Error(`metering: unknown keySource "${keySource}"`);
  if (!Number.isInteger(waivedCredits) || waivedCredits < 0) {
    throw new Error("metering: waivedCredits must be a non-negative integer");
  }
  const llmData = llm
    ? {
        llmProvider: llm.provider,
        llmModel: llm.model,
        llmWorkload: llm.workload,
        llmInputTokens: nonNegInt(llm.inputTokens, "inputTokens"),
        llmOutputTokens: nonNegInt(llm.outputTokens, "outputTokens"),
        llmCacheReadTokens: nonNegInt(llm.cacheReadTokens, "cacheReadTokens"),
        llmCacheWriteTokens: nonNegInt(llm.cacheWriteTokens, "cacheWriteTokens"),
        llmCostMicroUsd: llm.costMicroUsd === null ? null : BigInt(nonNegInt(llm.costMicroUsd, "costMicroUsd")),
        // Phase 17 (A1): observability columns (nullable; rounded to whole ms).
        llmTtftMs: typeof llm.ttftMs === "number" && Number.isFinite(llm.ttftMs) ? Math.max(0, Math.round(llm.ttftMs)) : null,
        llmDurationMs:
          typeof llm.durationMs === "number" && Number.isFinite(llm.durationMs) ? Math.max(0, Math.round(llm.durationMs)) : null,
        llmEffort: llm.effort ?? null,
        llmCacheHit: typeof llm.cacheHit === "boolean" ? llm.cacheHit : null,
        llmServiceTier: llm.serviceTier ?? null,
      }
    : {};

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
      async (tx): Promise<{ result: MeterResult; alert: { poolId: string; used: number; capCredits: number; alertAtPct: number; periodKey: string } | null }> => {
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

        // Phase 15.2: an agency client workspace charges the agency's ONE
        // pool — its balance, cap and alert. The event stays on workspaceId.
        const poolId = await resolvePoolWorkspaceId(tx, workspaceId);

        // Phase 17 (latency): a 0-credit event (a BYOK or self-hosted model
        // call, a value-priced call's tokens) changes no balance and passes
        // every cap check by definition — it is appended WITHOUT the balance
        // and cap row locks, so it never queues behind charged calls.
        if (charge === 0) {
          const event = await tx.usageEvent.create({
            data: {
              workspaceId,
              projectId,
              actorId,
              keyId,
              action,
              credits: 0,
              overageCredits: 0,
              idempotencyKey,
              evidenceRef,
              keySource,
              waivedCredits,
              chargedToWorkspaceId: poolId !== workspaceId ? poolId : null,
              ...llmData,
            },
            select: { id: true },
          });
          return { result: { ok: true, charged: 0, eventId: event.id }, alert: null };
        }

        // T2: lock balance + cap — concurrent meter() calls serialize here
        // (for a pool: every workspace in the pool serializes on the owner).
        const bal = await lockBalance(tx, poolId);
        const cap = await lockSpendCap(tx, poolId, bal.includedCredits + bal.purchasedCredits);
        // Read the plan after the locks: applyPlanChange takes the same locks,
        // so an upgrade that committed before us is always seen here.
        const ws = await tx.workspace.findUnique({
          where: { id: poolId },
          select: { plan: true, trialEndsAt: true },
        });
        const onTrial = ws?.plan === "trial";

        // Phase 3: an ended hosted trial is read-only for metered actions.
        // Zero-cost actions still pass — never punish the outcome.
        if (charge > 0 && !afterTheFact && ws && isTrialExpired(ws)) {
          return {
            result: {
              ok: false,
              reason: "cap_exceeded",
              charged: 0,
              message: trialExpiredMessage(ws.trialEndsAt),
              trialExpired: true,
            },
            alert: null,
          };
        }

        // T6: lazy period rollover inside the locked transaction, before charging.
        const now = new Date();
        let { periodStart, usedCredits, includedCredits, purchasedCredits, purchasedExpiresAt } = bal;
        let rolled = false;
        while (now >= addMonths(periodStart, 1)) {
          periodStart = addMonths(periodStart, 1);
          rolled = true;
        }
        if (rolled) {
          // The trial pool is one-time: a month boundary inside the 14 days
          // must not refill it.
          if (!onTrial) usedCredits = 0;
          if (purchasedExpiresAt && now > purchasedExpiresAt) {
            // applyTopUp raised the cap by every purchased credit; expiring
            // them must take that headroom back too, or the expired credits
            // stay spendable (unpaid, and unbilled without auto-overage).
            // Lowered by exactly the expired amount, so an admin's own
            // headroom above or below the pool is kept; never below 0.
            if (purchasedCredits > 0) {
              const capCredits = Math.max(0, cap.capCredits - purchasedCredits);
              await tx.spendCap.update({ where: { workspaceId: poolId }, data: { capCredits } });
              cap.capCredits = capCredits;
            }
            purchasedCredits = 0;
            purchasedExpiresAt = null;
          }
          await tx.creditBalance.update({
            where: { workspaceId: poolId },
            data: { periodStart, usedCredits, purchasedCredits, purchasedExpiresAt },
          });
        }

        // Cap check FIRST. Zero-cost actions always pass — never punish the outcome.
        // Auto-overage (explicit opt-in) also passes: the billing track bills
        // the overage; the ledger records it honestly.
        // A trial is always hard-capped: no overage opt-in, no uncapped legacy row.
        const overageAllowed = !onTrial && (cap.autoOverage || !cap.blockAtCap);
        // afterTheFact: the work already happened — record it honestly; the
        // pre-call gate is what refuses a capped workspace (Phase 15.2).
        if (charge > 0 && !afterTheFact && !overageAllowed && usedCredits + charge > cap.capCredits) {
          return {
            result: {
              ok: false,
              reason: "cap_exceeded",
              charged: 0,
              message: onTrial
                ? `Trial credits used up (${usedCredits.toLocaleString()} of ${cap.capCredits.toLocaleString()}). ` +
                  `Choose a plan in Billing (/dashboard/billing) to keep going.`
                : `Credit cap reached (${usedCredits.toLocaleString()} of ${cap.capCredits.toLocaleString()} ` +
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
          cap.autoOverage && !onTrial && charge > 0
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
            keySource,
            waivedCredits,
            chargedToWorkspaceId: poolId !== workspaceId ? poolId : null,
            ...llmData,
          },
          select: { id: true },
        });
        if (charge > 0) {
          await tx.creditBalance.update({
            where: { workspaceId: poolId },
            data: { usedCredits: { increment: charge } },
          });
          usedCredits += charge;
        }

        // 80% alert, once per period. Armed when lastAlertAt predates the period.
        let alert: { poolId: string; used: number; capCredits: number; alertAtPct: number; periodKey: string } | null = null;
        const threshold = Math.floor((cap.capCredits * cap.alertAtPct) / 100);
        const armed = !cap.lastAlertAt || cap.lastAlertAt < periodStart;
        if (charge > 0 && usedCredits >= threshold && armed) {
          await tx.spendCap.update({ where: { workspaceId: poolId }, data: { lastAlertAt: now } });
          alert = {
            poolId,
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
      // A pooled charge alerts the pool owner (the agency), once per period.
      const pooled = a.poolId !== workspaceId;
      await emitAlert({
        workspaceId: a.poolId,
        trigger: "metering_cap_warning",
        severity: "warn",
        title: pooled ? `Pooled credit usage at ${pct}% of cap` : `Credit usage at ${pct}% of cap`,
        body:
          `${a.used.toLocaleString()} of ${a.capCredits.toLocaleString()} credits used this period` +
          `${pooled ? " across the agency's client workspaces" : ""}. ` +
          `Add credits or raise the cap in Settings → Usage to avoid blocked actions.`,
        link: "/dashboard/settings/usage",
        dedupKey: `metering_cap_warning:${a.poolId}:${a.periodKey}`,
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
export async function checkCap(requestedWorkspaceId: string): Promise<CapStatus> {
  // Phase 15.2: an agency client workspace is capped by the agency's pool.
  const workspaceId = await resolvePoolWorkspaceId(prisma, requestedWorkspaceId);
  const [bal, cap, ws] = await Promise.all([
    prisma.creditBalance.findUnique({ where: { workspaceId } }),
    prisma.spendCap.findUnique({ where: { workspaceId } }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true, trialEndsAt: true } }),
  ]);
  const plan = ws?.plan ?? "self_hosted";
  const included = bal?.includedCredits ?? includedCreditsForPlan(plan);
  const purchased = bal?.purchasedCredits ?? 0;
  const used = bal?.usedCredits ?? 0;
  const capCredits = cap?.capCredits ?? included + purchased;
  // Mirrors meter(): a trial is always hard-capped, with no overage; with no
  // cap row yet, blocking follows what lockSpendCap will create.
  const onTrial = plan === "trial";
  const blockAtCap = onTrial || (cap?.blockAtCap ?? plan !== "self_hosted");
  const autoOverage = !onTrial && (cap?.autoOverage ?? false);
  const remaining = Math.max(0, capCredits - used);
  const trialExpired = ws ? isTrialExpired(ws) : false;
  return {
    allowed: !trialExpired && (!blockAtCap || autoOverage || remaining > 0),
    remaining,
    capCredits,
    used,
    autoOverage,
    trialExpired,
    hardCap: blockAtCap && !autoOverage,
    ...(workspaceId !== requestedWorkspaceId ? { poolWorkspaceId: workspaceId } : {}),
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
  // Phase 15.2: the pool this workspace spends (itself unless pooled), and
  // the workspaces sharing it. The balance and cap are the pool's.
  const poolId = await resolvePoolWorkspaceId(prisma, workspaceId);
  const members = await prisma.workspace.count({ where: { creditPoolOwnerId: poolId } });
  // Events charged to this pool: its own (charged_to null) plus every event a
  // client workspace charged to it — recorded per event, so history is right
  // after a workspace joins or leaves the pool.
  const chargedToPool = (id: string): Prisma.UsageEventWhereInput => ({
    OR: [{ chargedToWorkspaceId: id }, { workspaceId: id, chargedToWorkspaceId: null }],
  });
  const ownerHasPooledUsage =
    poolId === workspaceId && members === 0
      ? (await prisma.usageEvent.count({ where: { chargedToWorkspaceId: poolId }, take: 1 })) > 0
      : false;
  const pooled = poolId !== workspaceId || members > 0 || ownerHasPooledUsage;
  const isOwner = pooled && poolId === workspaceId;

  const bal = await prisma.creditBalance.findUnique({ where: { workspaceId: poolId } });
  let included = bal?.includedCredits ?? 0;
  if (!bal) {
    const ws = await prisma.workspace.findUnique({ where: { id: poolId }, select: { plan: true } });
    included = includedCreditsForPlan(ws?.plan ?? "self_hosted");
  }
  const purchased = bal?.purchasedCredits ?? 0;
  const start = opts.periodStart ? new Date(opts.periodStart) : (bal?.periodStart ?? monthStart(new Date()));
  // The owner's summary covers every workspace in its pool (so the ledger
  // reconciles with the pool counter); a client sees its own usage.
  const where: Prisma.UsageEventWhereInput = {
    ...(isOwner ? chargedToPool(poolId) : { workspaceId }),
    occurredAt: { gte: start },
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.keyId ? { keyId: opts.keyId } : {}),
  };
  const [byActionRows, byProjectRows, byKeyRows, waived, byWorkspaceRows] = await Promise.all([
    prisma.usageEvent.groupBy({ by: ["action"], where, _sum: { credits: true } }),
    prisma.usageEvent.groupBy({ by: ["projectId"], where, _sum: { credits: true } }),
    // byKey only when unfiltered (contract: sibling MCP track).
    opts.keyId
      ? Promise.resolve([])
      : prisma.usageEvent.groupBy({ by: ["keyId"], where, _sum: { credits: true } }),
    prisma.usageEvent.aggregate({ where: { ...where, keySource: "workspace" }, _sum: { waivedCredits: true } }),
    pooled
      ? prisma.usageEvent.groupBy({
          by: ["workspaceId"],
          where: { ...chargedToPool(poolId), occurredAt: { gte: start } },
          _sum: { credits: true },
        })
      : Promise.resolve([]),
  ]);
  const byAction: Record<string, number> = {};
  const byProject: Record<string, number> = {};
  const byCategory: Record<CreditCategory, number> = { ai: 0, data: 0, messaging: 0, compute: 0, other: 0 };
  let used = 0;
  for (const r of byActionRows) {
    const c = r._sum.credits ?? 0;
    byAction[r.action] = c;
    byCategory[categoryOf(r.action)] += c;
    used += c;
  }
  for (const r of byProjectRows) {
    byProject[r.projectId ?? "workspace"] = r._sum.credits ?? 0;
  }
  let poolUsed = used;
  let byWorkspace: Record<string, number> | undefined;
  if (pooled) {
    poolUsed = 0;
    byWorkspace = {};
    for (const r of byWorkspaceRows) {
      const c = r._sum.credits ?? 0;
      byWorkspace[r.workspaceId] = c;
      poolUsed += c;
    }
  }
  const summary: UsageSummary = {
    used,
    included,
    purchased,
    remaining: Math.max(0, included + purchased - poolUsed),
    byAction,
    byProject,
    periodStart: start.toISOString(),
    byCategory,
    byokSavedCredits: waived._sum.waivedCredits ?? 0,
  };
  if (pooled) {
    summary.pool = {
      ownerWorkspaceId: poolId,
      role: isOwner ? "owner" : "member",
      used: poolUsed,
      ...(isOwner ? { byWorkspace } : {}),
    };
  }
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
    throw new BadRequestError("top-up credits must be a positive integer");
  }
  return prisma.$transaction(async (tx) => {
    // Phase 15.2: credits bought in an agency client workspace go to the
    // pool it spends — never stranded on a balance nothing charges.
    workspaceId = await resolvePoolWorkspaceId(tx, workspaceId);
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
 * Plan change: set the workspace's plan tier AND re-sync its credit pool in
 * ONE locked transaction (balance + cap rows FOR UPDATE, so concurrent
 * meter() calls serialize behind it). includedCredits follows the plan; the
 * cap moves by the same delta — an upgrade raises it, a downgrade lowers it
 * — so any headroom an admin set relative to the pool is preserved. Floor 0.
 */
export async function applyPlanChange(
  workspaceId: string,
  plan: Plan,
  opts: { trialEndsAt?: Date | null; now?: Date } = {},
): Promise<{ includedCredits: number; capCredits: number }> {
  return prisma.$transaction(async (tx) => {
    const bal = await lockBalance(tx, workspaceId);
    const cap = await lockSpendCap(tx, workspaceId, bal.includedCredits + bal.purchasedCredits);
    const prev = await tx.workspace.findUnique({
      where: { id: workspaceId },
      select: { plan: true, trialEndsAt: true },
    });
    // Phase 3: moving onto the trial plan never starts a fresh trial unless
    // the caller passes trialEndsAt. A lapsed subscription lands on an
    // already-ended trial: the earlier of the old trial end and now.
    let trialEndsAt: Date | null | undefined;
    if (plan === "trial") {
      const now = opts.now ?? new Date();
      trialEndsAt =
        opts.trialEndsAt !== undefined
          ? opts.trialEndsAt
          : prev?.trialEndsAt && prev.trialEndsAt < now
            ? prev.trialEndsAt
            : now;
    }
    await tx.workspace.update({
      where: { id: workspaceId },
      data: { plan, ...(trialEndsAt !== undefined ? { trialEndsAt } : {}) },
    });
    const includedCredits = includedCreditsForPlan(plan);
    const capCredits = Math.max(0, cap.capCredits + (includedCredits - bal.includedCredits));
    await tx.creditBalance.update({ where: { workspaceId }, data: { includedCredits } });
    // Crossing the self-hosted boundary flips blocking (BYO keys record but
    // never block; billed plans hard-cap). Otherwise keep the admin's choice.
    const wasSelfHosted = prev?.plan === "self_hosted";
    const isSelfHosted = plan === "self_hosted";
    await tx.spendCap.update({
      where: { workspaceId },
      data: { capCredits, ...(wasSelfHosted !== isSelfHosted ? { blockAtCap: !isSelfHosted } : {}) },
    });
    return { includedCredits, capCredits };
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
    throw new BadRequestError("capCredits must be a non-negative integer");
  }
  if (patch.alertAtPct !== undefined && (!Number.isInteger(patch.alertAtPct) || patch.alertAtPct < 1 || patch.alertAtPct > 100)) {
    throw new BadRequestError("alertAtPct must be an integer 1–100");
  }
  return prisma.$transaction(async (tx) => {
    // Phase 15.2: a client workspace in an agency pool does not set the
    // agency's cap — the agency manages it from its own workspace.
    if ((await resolvePoolWorkspaceId(tx, workspaceId)) !== workspaceId) {
      throw new BadRequestError(
        "This workspace spends its agency's pooled credits; the agency workspace manages the spend cap.",
      );
    }
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
