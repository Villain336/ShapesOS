// Marketr — Phase 9 M1: approval executor (docs/specs/SPEC-PHASE9.md §3.3, §P9E).
//
// PROPOSE/EXECUTE SEPARATION: LLM agents may only DRAFT approval requests.
// Only this non-LLM service executes, and only with human-signed authority.
//
// Every assertion must pass or the execution HALTS with ApprovalError:
//   (0) workspace not frozen (checked FIRST — kill switch),
//   (a) approval exists, status approved, unexpired, unrevoked,
//       and its mission (if any) is not paused,
//   (b) bindingHash matches the canonicalized action payload (TOCTOU kill),
//   (c) DoA tier re-evaluated AT EXECUTION TIME — Tier 3 always throws,
//       Tier 2 requires the approval (present), Tier 1 requires the
//       automation toggle on; an action whose tier ESCALATED since approval
//       also halts,
//   (d) a hash-chained event is appended to the audit trail.
//
// Store is injected (memory twin for batteries/tests; Prisma twin for prod).

import {
  ApprovalError,
  bindingHashOf,
  canonicalize,
  eventHashFor,
  sha256Hex,
} from "./approvals";
// Re-export for consumers: executor pre-flight HALTs with this error type.
export { ApprovalError };
import {
  DEFAULT_SMALL_ACTION_THRESHOLD_CENTS,
  evaluateTier,
  type DoATier,
  type TierAction,
  type TierSettings,
} from "../orchestrator/authority";

export type MissionApprovalStatusName =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "revoked"
  | "executed";

export interface StoredMissionApproval {
  id: string;
  workspaceId: string;
  missionId: string | null;
  action: string;
  /** Tier evaluated when the approval was REQUESTED. */
  tier: number;
  bindingJson: Record<string, unknown>;
  bindingHash: string;
  status: MissionApprovalStatusName;
  expiresAt: Date | null;
  decidedAt: Date | null;
  createdBy: string;
  createdAt: Date;
}

export interface ExecutorChainEvent {
  approvalId: string;
  workspaceId: string;
  ts: Date;
  actor: string;
  action: string;
  payloadHash: string;
  prevHash: string;
  eventHash: string;
  detail: Record<string, unknown>;
}

export interface MissionApprovalStore {
  get(approvalId: string, workspaceId: string): Promise<StoredMissionApproval | null>;
  create(input: {
    workspaceId: string;
    missionId?: string | null;
    action: string;
    tier: number;
    bindingJson: Record<string, unknown>;
    createdBy: string;
    expiresAt?: Date | null;
  }): Promise<StoredMissionApproval>;
  setStatus(
    approvalId: string,
    workspaceId: string,
    status: MissionApprovalStatusName,
    patch?: Partial<Pick<StoredMissionApproval, "decidedAt">>,
  ): Promise<StoredMissionApproval>;
  /** Append a hash-chained executor event (per-approval chain). */
  appendEvent(
    approvalId: string,
    workspaceId: string,
    actor: string,
    action: string,
    detail: Record<string, unknown>,
  ): Promise<ExecutorChainEvent>;
}

// ---------------------------------------------------------------------------
// Memory twin (batteries / tests). Same interface as the Prisma store.
// ---------------------------------------------------------------------------

let idCounter = 0;
function cuid(prefix = "mx"): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function createMemoryMissionApprovalStore(): MissionApprovalStore {
  const approvals = new Map<string, StoredMissionApproval>();
  const chains = new Map<string, string>(); // approvalId -> last eventHash
  const events: ExecutorChainEvent[] = [];

  function scoped(approvalId: string, workspaceId: string): StoredMissionApproval {
    const a = approvals.get(approvalId);
    if (!a || a.workspaceId !== workspaceId) throw new ApprovalError("Approval not found in workspace.");
    return a;
  }

  return {
    async get(approvalId, workspaceId) {
      const a = approvals.get(approvalId);
      return a && a.workspaceId === workspaceId ? a : null;
    },
    async create(input) {
      const a: StoredMissionApproval = {
        id: cuid("mx"),
        workspaceId: input.workspaceId,
        missionId: input.missionId ?? null,
        action: input.action,
        tier: input.tier,
        bindingJson: input.bindingJson,
        bindingHash: bindingHashOf(input.bindingJson),
        status: "pending",
        expiresAt: input.expiresAt ?? null,
        decidedAt: null,
        createdBy: input.createdBy,
        createdAt: new Date(),
      };
      approvals.set(a.id, a);
      chains.set(a.id, "GENESIS");
      return a;
    },
    async setStatus(approvalId, workspaceId, status, patch) {
      const a = scoped(approvalId, workspaceId);
      a.status = status;
      if (patch?.decidedAt) a.decidedAt = patch.decidedAt;
      return a;
    },
    async appendEvent(approvalId, workspaceId, actor, action, detail) {
      const a = scoped(approvalId, workspaceId);
      const ts = new Date();
      const payloadHash = sha256Hex(canonicalize(detail));
      const prevHash = chains.get(a.id) ?? "GENESIS";
      const ev: ExecutorChainEvent = {
        approvalId: a.id,
        workspaceId: a.workspaceId,
        ts,
        actor,
        action,
        payloadHash,
        prevHash,
        eventHash: eventHashFor(prevHash, a.id, action, payloadHash, ts),
        detail,
      };
      chains.set(a.id, ev.eventHash);
      events.push(ev);
      return ev;
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 14 (approvals): a rule may approve a mission approval
// ---------------------------------------------------------------------------

/**
 * Approve a PENDING mission approval on an automation rule's authority
 * (decision from lib/automation/policy.ts decideAutoApproval — never Tier 3,
 * never destructive). Appends a hash-chained "auto_approved" event naming
 * the rule. Approvals without a mission can't be chain-logged, so they stay
 * pending (a person decides). Returns the approval as it now stands.
 */
export async function autoApproveMissionApproval(
  store: MissionApprovalStore,
  approval: StoredMissionApproval,
  decision: { auto: boolean; tier: DoATier; reason: string } | null,
  now: Date = new Date(),
): Promise<StoredMissionApproval> {
  if (!decision?.auto || decision.tier === 3 || approval.status !== "pending" || !approval.missionId) return approval;
  await store.appendEvent(approval.id, approval.workspaceId, "automation", "auto_approved", {
    rule: decision.reason,
    tier: decision.tier,
    actionKind: approval.action,
  });
  return store.setStatus(approval.id, approval.workspaceId, "approved", { decidedAt: now });
}

// ---------------------------------------------------------------------------
// executeApproved
// ---------------------------------------------------------------------------

export interface ExecuteApprovedInput {
  approvalId: string;
  /** The exact action payload — must byte-match the approved binding. */
  action: Record<string, unknown> & TierAction;
  workspaceId: string;
}

export interface ExecuteApprovedDeps {
  store: MissionApprovalStore;
  /** Kill-switch check #1: workspace freeze. Checked FIRST. */
  isWorkspaceFrozen: (workspaceId: string) => Promise<boolean> | boolean;
  /** Kill-switch check #2: mission pause (for approvals bound to a mission). */
  isMissionPaused: (missionId: string, workspaceId: string) => Promise<boolean> | boolean;
  /** Tier settings resolved for this action (M6: from automation_settings). */
  tierSettings?: TierSettings;
  /**
   * Phase 14 (approvals): resolve the tier settings for THIS action from the
   * workspace's automation rules (agent-aware) — production passes
   * lib/automation/policy.ts automationTierSettingsFor(workspaceId, agentKey).
   * Wins over `tierSettings`. Tier 3 still always halts.
   */
  resolveTierSettings?: (action: TierAction) => Promise<TierSettings> | TierSettings;
  now?: () => Date;
}

export interface ExecuteApprovedResult {
  approval: StoredMissionApproval;
  tier: DoATier;
  event: ExecutorChainEvent;
}

function defaultTierSettings(): TierSettings {
  return {
    smallActionThresholdCents: DEFAULT_SMALL_ACTION_THRESHOLD_CENTS,
    automationAllows: false,
    defaultCurrency: "USD",
    rates: { USD: 1 },
  };
}

/**
 * executeApproved — the ONLY path by which an approved action executes.
 * Non-LLM. Every pre-flight assertion must pass or the execution HALTS
 * with ApprovalError (status stays `approved`; nothing runs).
 */
export async function executeApproved(
  input: ExecuteApprovedInput,
  deps: ExecuteApprovedDeps,
): Promise<ExecuteApprovedResult> {
  const { approvalId, action, workspaceId } = input;
  const { store } = deps;
  const now = deps.now?.() ?? new Date();
  let tierSettings: TierSettings = { ...defaultTierSettings(), ...deps.tierSettings };

  // (0) Kill switch FIRST: a frozen workspace halts everything.
  if (await deps.isWorkspaceFrozen(workspaceId)) {
    throw new ApprovalError("Workspace is frozen — execution HALTED. Unfreeze the workspace to resume.");
  }

  // (a) Approval exists, is approved, unexpired, unrevoked.
  const approval = await store.get(approvalId, workspaceId);
  if (!approval) throw new ApprovalError("Approval not found in workspace — execution HALTED.");
  if (approval.status !== "approved") {
    throw new ApprovalError(
      `Cannot execute approval in status "${approval.status}" — execution HALTED. Only approved approvals execute.`,
    );
  }
  if (approval.expiresAt && approval.expiresAt.getTime() <= now.getTime()) {
    await store.setStatus(approvalId, workspaceId, "expired");
    throw new ApprovalError("Approval expired — execution HALTED. Re-request approval.");
  }
  if (approval.missionId && (await deps.isMissionPaused(approval.missionId, workspaceId))) {
    throw new ApprovalError("Mission is paused — execution HALTED. Resume the mission first.");
  }

  // (b) Binding re-verification: the approved payload is EXACTLY what executes.
  if (bindingHashOf(action) !== approval.bindingHash) {
    await store.appendEvent(approvalId, workspaceId, "executor", "execution_halted", {
      reason: "binding_mismatch",
      expected: approval.bindingHash,
    });
    throw new ApprovalError("Binding mismatch — execution HALTED. Payload does not match the approved binding.");
  }

  // (c) DoA tier re-evaluated AT EXECUTION TIME. The agent's label is untrusted.
  // Phase 14: the automation rules for this action decide the toggle (an
  // approval a rule granted at Tier 1 halts if the rule was switched off).
  if (deps.resolveTierSettings) {
    tierSettings = { ...defaultTierSettings(), ...(await deps.resolveTierSettings(action)) };
  }
  const tier = evaluateTier(action, tierSettings);
  if (tier === 3) {
    await store.appendEvent(approvalId, workspaceId, "executor", "execution_halted", {
      reason: "tier_3_hard_deny",
      actionKind: action.kind,
    });
    throw new ApprovalError(
      "Tier 3 action (money movement / contract signing / data deletion) — execution HALTED. Tier 3 is un-overridable.",
    );
  }
  if (tier > approval.tier) {
    await store.appendEvent(approvalId, workspaceId, "executor", "execution_halted", {
      reason: "tier_escalated_since_approval",
      approvedTier: approval.tier,
      evaluatedTier: tier,
    });
    throw new ApprovalError(
      `Action tier escalated since approval (approved at Tier ${approval.tier}, now Tier ${tier}) — execution HALTED. Re-request approval.`,
    );
  }
  if (tier === 1 && tierSettings.automationAllows !== true) {
    await store.appendEvent(approvalId, workspaceId, "executor", "execution_halted", {
      reason: "tier_1_automation_toggle_off",
    });
    throw new ApprovalError(
      "Tier 1 action requires the automation toggle to be ON — execution HALTED. Enable the toggle or approve explicitly.",
    );
  }
  // Tier 2: the approval itself is the authority — present and verified above.

  // (d) Mark executed + append the hash-chained event.
  const executed = await store.setStatus(approvalId, workspaceId, "executed");
  const event = await store.appendEvent(approvalId, workspaceId, "executor", "executed", {
    tier,
    bindingHash: approval.bindingHash,
    actionKind: action.kind,
  });

  return { approval: executed, tier, event };
}
