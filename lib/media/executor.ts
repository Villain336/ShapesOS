// Marketr — Phase 5 S3: executor pre-flight re-verification.
//
// What was approved is exactly what executes, or nothing executes.
// Every assertion must pass or the buy HALTs:
//
// HALT semantics: status stays "approved" (never "executed"), the exact
// diff is recorded on the approval event log, and the approver + requester
// are notified. Re-approval covers only what changed.
//
// Prompt-injection defense: operator confirmation pages are UNTRUSTED data.
// The executor parses them against the approved order and never obeys them;
// any instruction-like content is ignored, and any mismatch = halt + alert.

import {
  ApprovalStatus,
  SafetyViolationError,
  assertApprovalTransition,
  isApprovalExpired,
  requireHumanSupervisedApproval,
  sha256Hex,
} from "./safety";
import {
  ApprovalStore,
  BuyBinding,
  MediaApproval,
  canonicalize,
  logApprovalEvent,
  verifyApproverReceipts,
  verifyBinding,
} from "./approvals";
import { PoolStore, convertEncumbranceToSpend } from "./pools";

export interface QuoteRefetch {
  quoteId: string;
  expiresAt: Date;
  priceCents: number;
}

export interface ExecutorHooks {
  /** Direct deals: re-fetch the (non-binding) quote. Null = quote gone. */
  refetchQuote(quoteId: string): Promise<QuoteRefetch | null>;
  /** Auction: recompute creative hashes from the source of truth. */
  rehashCreatives(creativeIds: string[]): Promise<Record<string, string>>;
  getPoolState(poolId: string): Promise<{ remainingCents: number; allowlist: string[]; status: string } | null>;
  getAccountCeilings(platform: string, adAccountId: string): Promise<{ spendingLimitCents: number | null; budgetsOk: boolean }>;
  getCreativeReviewStatus(creativeIds: string[]): Promise<"approved" | "pending" | "rejected">;
  getBillingValid(adAccountId: string): Promise<boolean>;
  /** Platform guardrail writes at approved values (B-track implementations). */
  writePlatformGuardrails(buy: ExecutedBuy): Promise<void>;
  /** Register the buy with the kill-switch sweeper (S4). */
  registerWithSweeper(buy: ExecutedBuy): Promise<void>;
  notify(recipients: string[], subject: string, body: string): Promise<void>;
  now(): Date;
}

export interface ExecutedBuy {
  approvalId: string;
  workspaceId: string;
  poolId: string;
  platform: string;
  clientAdAccountId: string;
  platformCampaignRef: string | null;
}

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
  diff?: unknown;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
  haltReason?: string;
  diff?: unknown;
}

export class ExecutionHaltError extends SafetyViolationError {
  readonly diff: unknown;
  constructor(reason: string, diff?: unknown) {
    super(`EXECUTION HALTED: ${reason}`);
    this.name = "ExecutionHaltError";
    this.diff = diff;
  }
}

function check(name: string, ok: boolean, detail: string, diff?: unknown): PreflightCheck {
  return { name, ok, detail, diff };
}

/** Default no-op hooks for dry runs (fake provider world). */
export function defaultTestHooks(overrides: Partial<ExecutorHooks> = {}): ExecutorHooks {
  return {
    refetchQuote: async () => null,
    rehashCreatives: async (ids) => Object.fromEntries(ids.map((id) => [id, "unverifiable-in-test"])),
    getPoolState: async () => null,
    getAccountCeilings: async () => ({ spendingLimitCents: null, budgetsOk: true }),
    getCreativeReviewStatus: async () => "approved",
    getBillingValid: async () => true,
    writePlatformGuardrails: async () => {},
    registerWithSweeper: async () => {},
    notify: async (recipients, subject, body) => {
      console.log(`[media-executor notify] to=${recipients.join(",")} subject=${subject} body=${body.slice(0, 200)}`);
    },
    now: () => new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Prompt-injection defense: operator pages are data, never instructions.
// ---------------------------------------------------------------------------

const INSTRUCTION_PATTERNS = [
  /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|instruction)/i,
  /\bnew instructions?\b/i,
  /\bsystem prompt\b/i,
  /\bdo not (halt|stop|verify|check)\b/i,
  /\bproceed (with|to) (execut|book|purchas)/i,
];

/**
 * Parse an operator confirmation screen AGAINST the approved order. Numbers
 * and dates are extracted and compared to the binding; any instruction-like
 * text is flagged and ignored (never obeyed). Returns mismatches — a
 * non-empty list means HALT.
 */
export function parseConfirmationAgainstOrder(
  operatorText: string,
  binding: BuyBinding,
): { mismatches: string[]; injectionFlags: string[] } {
  const mismatches: string[] = [];
  const injectionFlags: string[] = [];
  for (const re of INSTRUCTION_PATTERNS) {
    if (re.test(operatorText)) injectionFlags.push(`instruction-like content matched ${re.source.slice(0, 40)}…`);
  }
  // Extract dollar amounts and compare the largest to maxTotalSpendCents.
  const amounts = [...operatorText.matchAll(/\$[\d,]+(?:\.\d{2})?/g)].map((m) =>
    Math.round(Number(m[0].replace(/[$,]/g, "")) * 100),
  );
  if (amounts.length > 0) {
    const shown = Math.max(...amounts);
    if (shown !== binding.maxTotalSpendCents) {
      mismatches.push(`operator shows $${(shown / 100).toFixed(2)} vs approved $${(binding.maxTotalSpendCents / 100).toFixed(2)}`);
    }
  }
  // Flight dates must appear on the confirmation.
  if (!operatorText.includes(binding.flightStart.slice(0, 10))) {
    mismatches.push(`operator confirmation missing approved flight start ${binding.flightStart.slice(0, 10)}`);
  }
  return { mismatches, injectionFlags };
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

export interface PreflightDeps {
  approvalStore: ApprovalStore;
  poolStore: PoolStore;
  hooks: ExecutorHooks;
  /** MediaBuy persistence for the success path (optional in dry runs). */
  buyStore?: {
    create(buy: Omit<ExecutedBuy, "platformCampaignRef"> & { platformCampaignRef: string | null }): Promise<void>;
  };
  receiptSecret?: string;
}

export async function runPreflight(
  approvalId: string,
  workspaceId: string,
  deps: PreflightDeps,
): Promise<PreflightResult> {
  const { approvalStore, poolStore, hooks } = deps;
  const now = hooks.now();
  const checks: PreflightCheck[] = [];

  const approval = await approvalStore.get(approvalId, workspaceId);
  if (!approval) {
    return { ok: false, checks: [check("approval-exists", false, "Approval not found in workspace.")] };
  }
  const b = approval.binding;

  // 1. Approved + unexpired + unrevoked.
  const alive = approval.status === "approved" && !isApprovalExpired(approval.approvalsExpiresAt, now);
  checks.push(check(
    "approval-alive", alive,
    `status=${approval.status} expires=${approval.approvalsExpiresAt?.toISOString() ?? "n/a"}`,
    { status: approval.status, expired: isApprovalExpired(approval.approvalsExpiresAt, now) },
  ));

  // 2. Two-person provenance (creator ≠ approver; receipts verify).
  let twoPerson = false;
  let twoPersonDetail = "";
  try {
    const creatorOk = !approval.approvers.some((r) => r.userId === approval.createdBy);
    const receiptsOk = verifyApproverReceipts(approval, deps.receiptSecret);
    twoPerson = approval.twoPersonSatisfied && creatorOk && receiptsOk && approval.approvers.length > 0;
    twoPersonDetail = `twoPersonSatisfied=${approval.twoPersonSatisfied} creatorExcluded=${creatorOk} receiptsValid=${receiptsOk}`;
  } catch (e) {
    twoPersonDetail = `verification error: ${e instanceof Error ? e.message : String(e)}`;
  }
  checks.push(check("two-person-provenance", twoPerson, twoPersonDetail));

  // Structural invariant: buying modules can never run without a human approval.
  try {
    requireHumanSupervisedApproval("dooh_buy", { status: approval.status, approvers: approval.approvers });
    checks.push(check("ladder-invariant", true, "buying rung supervised; human approval present"));
  } catch (e) {
    checks.push(check("ladder-invariant", false, e instanceof Error ? e.message : String(e)));
  }

  // Binding integrity: recompute the hash — any post-approval edit = halt.
  const bindingOk = verifyBinding(b, approval.bindingHash);
  checks.push(check(
    "binding-integrity", bindingOk,
    bindingOk ? "sha256(binding) matches approval" : "BINDING TAMPERED: hash mismatch — re-approval required",
    bindingOk ? undefined : { expected: approval.bindingHash, actual: sha256Hex(canonicalize(b)) },
  ));

  // 3. Direct deals: re-fetch quote; not expired; price within drift tolerance.
  if (b.dealType !== "auction") {
    if (!b.quoteId) {
      checks.push(check("quote", false, "Direct deal without quoteId — quote-then-book violated."));
    } else {
      const quote = await hooks.refetchQuote(b.quoteId);
      if (!quote) {
        checks.push(check("quote", false, `Quote ${b.quoteId} no longer retrievable — re-quote, never execute stale.`, { quoteId: b.quoteId }));
      } else {
        const fresh = now < quote.expiresAt;
        const driftPct = Math.abs(quote.priceCents - b.maxTotalSpendCents) / b.maxTotalSpendCents * 100;
        const withinDrift = driftPct <= b.driftTolerance.pricePct;
        const ok = fresh && withinDrift;
        checks.push(check(
          "quote", ok,
          `fresh=${fresh} priceDrift=${driftPct.toFixed(2)}% (tolerance ${b.driftTolerance.pricePct}%)`,
          ok ? undefined : { quotePriceCents: quote.priceCents, approvedCents: b.maxTotalSpendCents, expired: !fresh },
        ));
      }
    }
  } else {
    checks.push(check("quote", true, "auction deal — no quote required"));
  }

  // 4. Auction: re-hash creatives; diff launch config vs approved targeting.
  if (b.dealType === "auction") {
    const fresh = await hooks.rehashCreatives(b.creativeIds);
    const mismatched = b.creativeIds.filter((id, i) => fresh[id] !== b.creativeHashes[i]);
    checks.push(check(
      "creative-hash", mismatched.length === 0,
      mismatched.length === 0
        ? `${b.creativeIds.length} creative(s) re-hashed OK`
        : `CREATIVE SWAP: ${mismatched.join(", ")} hash mismatch — the human approved THAT creative, not a lookalike`,
      mismatched.length ? { mismatched } : undefined,
    ));
  } else {
    checks.push(check("creative-hash", true, "direct deal — creative bound via line items"));
  }

  // 5. Pool allowlist + THIS approval's reserved encumbrance ≥ max spend;
  //    6. account ceilings.
  // NOTE (double-count fix): approval already moved maxTotalSpendCents from
  // pool.remainingCents into pool.encumberedCents. A remaining-based check
  // would demand the same money twice and falsely HALT fully-funded buys.
  // Pre-flight instead verifies the reservation recorded at approval time.
  if (approval.poolId) {
    const pool = await hooks.getPoolState(approval.poolId).catch(() => null)
      ?? await poolStore.get(approval.poolId, workspaceId).then((p) => p && ({
        remainingCents: p.remainingCents, allowlist: p.platformAllowlist, status: p.status,
      }));
    if (!pool) {
      checks.push(check("pool", false, "Pool not found in workspace."));
    } else {
      const platformOk = pool.allowlist.includes(b.platform.toLowerCase());
      const reserved = await poolStore.reservedForApproval(approval.poolId, workspaceId, approval.id).catch(() => 0);
      // "exhausted" means remaining=0 (no NEW encumbrances) — but this buy's
      // reservation already exists, so it passes. "frozen" (emergency stop)
      // always fails closed.
      const statusOk = pool.status === "active" || pool.status === "exhausted";
      const fundsOk = reserved >= b.maxTotalSpendCents && statusOk;
      checks.push(check(
        "pool", platformOk && fundsOk,
        `allowlisted=${platformOk} reserved=${reserved}c ≥ max=${b.maxTotalSpendCents}c status=${pool.status}`,
        platformOk && fundsOk ? undefined : { reservedCents: reserved, status: pool?.status },
      ));
    }
  } else {
    checks.push(check("pool", false, "Approval has no pool — every buy must draw from a pool."));
  }

  const ceilings = await hooks.getAccountCeilings(b.platform, b.clientAdAccountId).catch(() => null);
  const ceilingsOk = !!ceilings && ceilings.budgetsOk;
  checks.push(check(
    "account-ceilings", ceilingsOk,
    ceilings ? `spendingLimit=${ceilings.spendingLimitCents ?? "n/a"} budgetsOk=${ceilings.budgetsOk}` : "ceiling lookup failed",
  ));

  // 7. Creative review + billing valid (client's own instrument).
  const review = await hooks.getCreativeReviewStatus(b.creativeIds).catch(() => "pending" as const);
  checks.push(check("creative-review", review === "approved", `review=${review}`));
  const billing = await hooks.getBillingValid(b.clientAdAccountId).catch(() => false);
  checks.push(check("billing", billing, billing ? "client billing instrument valid" : "billing invalid — client's own instrument required"));

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    return {
      ok: false,
      checks,
      haltReason: failed.map((c) => `${c.name}: ${c.detail}`).join(" | "),
      diff: Object.fromEntries(failed.map((c) => [c.name, c.diff ?? c.detail])),
    };
  }
  return { ok: true, checks };
}

/**
 * Execute: run pre-flight; on HALT keep status "approved", log, notify.
 * On pass: write guardrails, register with sweeper, convert encumbrance →
 * spend, mark executed, create the MediaBuy row.
 */
export async function executeBuy(
  approvalId: string,
  workspaceId: string,
  actor: string,
  deps: PreflightDeps,
): Promise<{ executed: boolean; preflight: PreflightResult; buy?: ExecutedBuy }> {
  const { approvalStore, poolStore, hooks } = deps;
  const approval = await approvalStore.get(approvalId, workspaceId);
  if (!approval) throw new ExecutionHaltError("Approval not found in workspace.");

  const preflight = await runPreflight(approvalId, workspaceId, deps);
  if (!preflight.ok) {
    await logApprovalEvent(approvalStore, approvalId, workspaceId, "system", "execution_halted", {
      haltReason: preflight.haltReason,
      diff: preflight.diff,
    });
    await hooks.notify(
      [approval.createdBy, ...approval.approvers.map((r) => r.userId)],
      `Media buy HALTED — pre-flight failed`,
      `Approval ${approvalId} did not execute. Status stays "approved". Diff: ${JSON.stringify(preflight.diff)}`,
    );
    return { executed: false, preflight };
  }

  const buy: ExecutedBuy = {
    approvalId: approval.id,
    workspaceId,
    poolId: approval.poolId!,
    platform: approval.binding.platform,
    clientAdAccountId: approval.binding.clientAdAccountId,
    platformCampaignRef: null,
  };

  try {
    // Platform-native guardrails at approved values + sweeper registration
    // happen BEFORE money moves (defense in depth).
    await hooks.writePlatformGuardrails(buy);
    await hooks.registerWithSweeper(buy);
    await convertEncumbranceToSpend(poolStore, {
      poolId: approval.poolId!,
      workspaceId,
      approvalId: approval.id,
      amountCents: approval.maxSpendCents,
      actor,
    });
    assertApprovalTransition(approval.status as ApprovalStatus, "executed");
    await approvalStore.update(approvalId, workspaceId, { status: "executed", executedAt: hooks.now() });
    await logApprovalEvent(approvalStore, approvalId, workspaceId, actor, "executed", {
      bindingHash: approval.bindingHash,
      maxSpendCents: approval.maxSpendCents,
    });
    await deps.buyStore?.create(buy);
    return { executed: true, preflight, buy };
  } catch (err) {
    await logApprovalEvent(approvalStore, approvalId, workspaceId, "system", "execution_halted", {
      haltReason: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
