// Marketr — Phase 17 slice 1: the Operations approval gate.
//
// Classification + fail-closed execution for money-moving Operations
// writes, built ON TOP of the Phase 14 gate (lib/integrations/actions/gate.ts)
// — ops money actions flow through the SAME propose → approve/deny/edit →
// execute → audit pipeline (same approve/deny queue UI, same audit trail).
//
// Locked doctrine (spec §4, Tico-locked):
//   - reads + draft-creators run freely (logged)
//   - sends / charges / refunds / deletes are gated writes
//   - money-moving = medium gate MINIMUM, bulk refunds = high gate
//   - invoice SEND and refunds MUST go through the gate
//
// The ops layer pins an EXPECTED minimum tier per money action; the Phase 14
// classifier must meet or exceed it (conservative floor holds — overrides
// may escalate, never downgrade). If the Phase 14 derivation ever came back
// weaker than the pin, proposal fails closed.
//
// executeGatedOpsWrite() is the ONLY path that applies a gated mutation.
// It fails closed on: missing approval, unknown/denied/pending/expired
// approval, and binding mismatch (the approval's bound mutation must equal
// the mutation being executed — canonical JSON compare, so "approve $100,
// execute $10,000" is impossible).
//
// consumeOpsApproval() is the replay lock: after verification, the write
// path claims the approval approved → executed with a status-guarded
// updateMany IN THE SAME TRANSACTION as the mutation. Exactly one caller
// can win the claim (count === 1); a replay or a concurrent second request
// gets count 0 and fails closed — and if the write itself fails, the
// transaction rolls the claim back so the approval is not burned.

import { canonicalize } from "@/lib/authority/approvals";
import {
  classifyAction,
  type RiskTier,
} from "@/lib/integrations/actions/risk";
// Re-exported for ops tests and consumers that pin the tier lattice.
export type { RiskTier };
import {
  getApproval,
  proposeAction,
} from "@/lib/integrations/actions/gate";
import { redactArgs } from "@/lib/integrations/actions/redact";
import { OPS_ENTITY_MAP } from "./entities";
import { NotFoundError } from "@/lib/api/errors";

const TIER_RANK: Record<RiskTier, number> = { low: 0, medium: 1, high: 2 };

export class OpsGateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OpsGateError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Money-action catalog: the ops actions that can never run without approval.
// ---------------------------------------------------------------------------

export interface OpsMoneyAction {
  slug: string;
  label: string;
  /** Minimum tier — the Phase 14 derivation must meet or exceed this. */
  expectedTier: RiskTier;
}

export const OPS_MONEY_ACTIONS: OpsMoneyAction[] = [
  { slug: "OPS_INVOICE_SEND", label: "Send invoice", expectedTier: "medium" },
  { slug: "OPS_INVOICE_MARK_PAID", label: "Mark invoice paid", expectedTier: "medium" },
  // Slice 2: outbound payment reminders are money comms — gated like sends.
  { slug: "OPS_INVOICE_REMIND", label: "Send payment reminder", expectedTier: "medium" },
  // Slice 3: sending a purchase order is a money commitment — gated like
  // invoice sends. Phase 14 derives unknown OPS_* slugs as high
  // (conservative floor), which meets the medium pin.
  { slug: "OPS_PO_SEND", label: "Send purchase order", expectedTier: "medium" },
  { slug: "OPS_PAYMENT_RECORD_CHARGE", label: "Record charge", expectedTier: "medium" },
  { slug: "OPS_PAYMENT_REFUND", label: "Refund payment", expectedTier: "medium" },
  { slug: "OPS_PAYMENT_BULK_REFUND", label: "Bulk refund", expectedTier: "high" },
  { slug: "OPS_ORDER_CANCEL", label: "Cancel order", expectedTier: "medium" },
  { slug: "OPS_ORDER_FULFILL", label: "Fulfill order", expectedTier: "medium" },
  // Slice 5: approving a leave request is a manager decision — gated like
  // other ops approvals (medium pin). Denying and marking taken are free.
  { slug: "OPS_LEAVE_APPROVE", label: "Approve leave request", expectedTier: "medium" },
  // Slice 6: running a money-moving operations workflow. ONE approval covers
  // the full step plan + the pre-authorized rollback plan (see
  // lib/ops/workflows.ts) — the runner verifies it once, fail-closed, and
  // steps/compensations execute under it. Phase 14 derives unknown OPS_*
  // slugs as high (conservative floor), which meets the medium pin.
  { slug: "OPS_WORKFLOW_RUN", label: "Run operations workflow", expectedTier: "medium" },
  { slug: "OPS_RECORD_DELETE", label: "Delete operations record", expectedTier: "medium" },
  // Phase 10 (finance): posting to / reversing the ledger, credit notes,
  // quote sends, vendor bill payments and expense approvals/reimbursements.
  // Phase 14 derives unknown OPS_* slugs as high, which meets the pins.
  { slug: "OPS_JOURNAL_POST", label: "Post journal entry", expectedTier: "medium" },
  { slug: "OPS_JOURNAL_REVERSE", label: "Reverse journal entry", expectedTier: "medium" },
  { slug: "OPS_CREDIT_NOTE_ISSUE", label: "Issue credit note", expectedTier: "medium" },
  { slug: "OPS_QUOTE_SEND", label: "Send quote", expectedTier: "medium" },
  { slug: "OPS_BILL_PAY", label: "Pay vendor bill", expectedTier: "medium" },
  { slug: "OPS_EXPENSE_APPROVE", label: "Approve expense claim", expectedTier: "medium" },
  { slug: "OPS_EXPENSE_REIMBURSE", label: "Reimburse expense claim", expectedTier: "medium" },
  // Phase 12 (mfgpos): confirming a manufacturing order commits components
  // and the work plan; completing it moves stock and posts the costing to
  // the books; scrap writes stock off (and its value); closing a till
  // session posts the day's takings. Phase 14 derives unknown OPS_* slugs as
  // high, which meets the pins.
  { slug: "OPS_MO_CONFIRM", label: "Confirm manufacturing order", expectedTier: "medium" },
  { slug: "OPS_MO_COMPLETE", label: "Complete manufacturing order", expectedTier: "medium" },
  { slug: "OPS_SCRAP_POST", label: "Scrap stock", expectedTier: "medium" },
  { slug: "OPS_POS_SESSION_CLOSE", label: "Close till session", expectedTier: "medium" },
  // Phase 12 (people): approving a computed pay run (what every person is
  // paid) and posting it to the books. Never automated (Tier 3 kinds
  // approve_pay_run / post_pay_run); both bind the run's compute digest.
  { slug: "OPS_PAYROLL_APPROVE", label: "Approve pay run", expectedTier: "high" },
  { slug: "OPS_PAYROLL_POST", label: "Post pay run to the books", expectedTier: "medium" },
  // Phase 14 (connectors): writing a computed run's hours into the payroll
  // provider's (Gusto's) unprocessed payroll — what people will be paid.
  // Money: never automated (Tier 3 kind send_payroll_to_provider), bound to
  // the run's compute digest. Pinned medium like the other money sends
  // (OPS_INVOICE_SEND, OPS_BILL_PAY): the Phase 14 classifier derives the
  // SEND verb as medium, and a gated write needs a person's approval at any
  // tier.
  { slug: "OPS_PAYROLL_SEND_PROVIDER", label: "Send pay run to Gusto", expectedTier: "medium" },
  // Phase 13 (twincore): publishing a digital twin site layout (an agent's
  // twin_draft_layout output, or a person's edits) is a person's decision.
  // No money moves; it rides the same propose → approve → execute gate.
  { slug: "OPS_TWIN_SITE_PUBLISH", label: "Publish twin site layout", expectedTier: "medium" },
];

export const OPS_MONEY_ACTION_MAP: Record<string, OpsMoneyAction> =
  Object.fromEntries(OPS_MONEY_ACTIONS.map((a) => [a.slug, a]));

// ---------------------------------------------------------------------------
// Classification: which ops writes are free (logged) and which are gated.
// Pure + fixture-testable.
// ---------------------------------------------------------------------------

export type OpsWriteMode = "free" | "gated";

export interface OpsWriteClassification {
  mode: OpsWriteMode;
  /** low for free writes; the money-action pin for gated writes. */
  tier: RiskTier;
  /** Set when gated: the money-action slug to propose under. */
  slug?: string;
  label?: string;
  reason: string;
}

export interface ClassifyOpsWriteInput {
  entity: string;
  op: "create" | "update" | "delete";
  body: Record<string, unknown>;
}

function gated(slug: string, reason: string): OpsWriteClassification {
  const action = OPS_MONEY_ACTION_MAP[slug];
  if (!action) throw new OpsGateError("unknown_money_action", `Unknown money action ${slug}`);
  return { mode: "gated", tier: action.expectedTier, slug, label: action.label, reason };
}

function free(reason: string): OpsWriteClassification {
  return { mode: "free", tier: "low", reason };
}

/**
 * Classify an Operations write. Reads are not writes (they never reach
 * here) — they run freely, logged. Draft-creators (every POST except
 * payments, which are money records) run freely, logged. Everything the
 * locked doctrine names — sends, charges, refunds, deletes — is gated.
 */
export function classifyOpsWrite(input: ClassifyOpsWriteInput): OpsWriteClassification {
  const def = OPS_ENTITY_MAP[input.entity];
  if (!def) throw new OpsGateError("unknown_entity", `Unknown ops entity "${input.entity}"`);

  if (input.op === "create") {
    // Payments are money records, not drafts: EVERY payment write is gated.
    if (input.entity === "payments") {
      const kind = input.body.kind ?? "charge";
      const items = input.body.items;
      if (kind === "refund" && Array.isArray(items) && items.length > 1) {
        return gated(
          "OPS_PAYMENT_BULK_REFUND",
          `Bulk refund of ${items.length} payments — high gate`,
        );
      }
      if (kind === "refund") return gated("OPS_PAYMENT_REFUND", "Refund payment — gated write");
      return gated("OPS_PAYMENT_RECORD_CHARGE", "Record charge — gated write");
    }
    // Phase 10 (finance): entities whose create moves the books (manual
    // journal entries) declare their gate.
    if (def.createGate) return gated(def.createGate, `Create ${def.label} — gated write`);
    return free(`Draft-creator: create ${def.label} runs freely, logged`);
  }

  if (input.op === "delete") {
    return gated("OPS_RECORD_DELETE", `Delete ${def.label} — gated write`);
  }

  // update: gated when the patch moves a money field to a gated value.
  for (const t of def.gatedTransitions) {
    const v = input.body[t.field];
    if (typeof v === "string" && t.to.includes(v)) {
      return gated(t.slug, `${t.label} — gated write`);
    }
  }
  return free(`Update ${def.label} runs freely, logged`);
}

/**
 * Assert the Phase 14 classifier agrees with (or exceeds) the ops pin for
 * every money action. Catalog-drift style: if the derivation ever weakens
 * below the pin, this throws instead of silently gating wrong.
 */
export function assertPhase14TierMeetsPin(): Array<{ slug: string; expected: RiskTier; derived: RiskTier }> {
  return OPS_MONEY_ACTIONS.map((a) => {
    const derived = classifyAction(a.slug);
    if (TIER_RANK[derived.tier] < TIER_RANK[a.expectedTier]) {
      throw new OpsGateError(
        "tier_drift",
        `Phase 14 derives ${a.slug} as ${derived.tier}, below the ops pin ${a.expectedTier} — refusing to gate weakly`,
      );
    }
    return { slug: a.slug, expected: a.expectedTier, derived: derived.tier };
  });
}

// ---------------------------------------------------------------------------
// Gate port: the Phase 14 functions, swappable for a stub in tests.
// ---------------------------------------------------------------------------

export interface OpsGateProposal {
  id: string;
  status: string;
  riskTier: string;
}

export interface OpsGateApproval {
  id: string;
  status: string;
  expiresAt: Date;
  proposedArgs: unknown;
  /** Phase 14 append-only trail (the claim appends an execution entry). */
  auditTrail?: unknown;
}

export interface OpsGatePort {
  propose(input: {
    workspaceId: string;
    appKey: string;
    toolName: string;
    args: Record<string, unknown>;
    proposedBy: string;
    plainSummary: string;
  }): Promise<OpsGateProposal>;
  /**
   * Load an approval. When `tx` is given (the gated write's open transaction),
   * read through it: a second pooled connection per concurrent write exhausted
   * small pools and surfaced as a bogus "not found".
   */
  getApproval(workspaceId: string, id: string, tx?: unknown): Promise<OpsGateApproval>;
}

/** Production port: the real Phase 14 gate. */
export const phase14GatePort: OpsGatePort = {
  async propose(input) {
    const { approval, classified } = await proposeAction(input);
    // Fail closed: the Phase 14 tier must meet the ops pin.
    const pin = OPS_MONEY_ACTION_MAP[input.toolName];
    if (pin && TIER_RANK[classified.tier] < TIER_RANK[pin.expectedTier]) {
      throw new OpsGateError(
        "tier_drift",
        `Phase 14 classified ${input.toolName} as ${classified.tier}, below the ops pin ${pin.expectedTier}`,
      );
    }
    return { id: approval.id, status: approval.status, riskTier: approval.riskTier };
  },
  async getApproval(workspaceId: string, id: string, tx?: unknown) {
    const a = tx
      ? await (tx as ApprovalReadTx).composioActionApproval.findFirst({ where: { id, workspaceId } })
      : await getApproval(workspaceId, id);
    if (!a) throw new NotFoundError("Approval not found");
    return {
      id: a.id,
      status: a.status,
      expiresAt: a.expiresAt,
      proposedArgs: a.proposedArgs,
      auditTrail: a.auditTrail,
    };
  },
};

// ---------------------------------------------------------------------------
// Propose + verify. The binding is { entity, entityId?, slug, mutation } —
// verified with canonical JSON compare so an approval can never be replayed
// against a different record or a different mutation.
// ---------------------------------------------------------------------------

export interface OpsApprovalBinding {
  entity: string;
  entityId?: string;
  slug: string;
  /** The exact mutation the approval covers (redacted at proposal time). */
  mutation: Record<string, unknown>;
  // Index signature so the binding can ride inside proposeArgs
  // (Record<string, unknown>) without a cast.
  [key: string]: unknown;
}

export function opsBindingFor(args: {
  entity: string;
  entityId?: string;
  slug: string;
  mutation: Record<string, unknown>;
}): OpsApprovalBinding {
  return {
    entity: args.entity,
    ...(args.entityId ? { entityId: args.entityId } : {}),
    slug: args.slug,
    mutation: redactArgs(args.mutation) as Record<string, unknown>,
  };
}

/**
 * Propose a money action for human review. Returns the pending approval —
 * the caller surfaces it (202 + approval) and the mutation runs only after
 * approve + a second call carrying the approvalId.
 */
export async function requestOpsApproval(
  port: OpsGatePort,
  args: {
    workspaceId: string;
    slug: string;
    entity: string;
    entityId?: string;
    mutation: Record<string, unknown>;
    actor: string;
    summary: string;
  },
): Promise<OpsGateProposal> {
  const action = OPS_MONEY_ACTION_MAP[args.slug];
  if (!action) throw new OpsGateError("unknown_money_action", `Unknown money action ${args.slug}`);
  return port.propose({
    workspaceId: args.workspaceId,
    appKey: "ops",
    toolName: args.slug,
    args: opsBindingFor({
      entity: args.entity,
      entityId: args.entityId,
      slug: args.slug,
      mutation: args.mutation,
    }),
    proposedBy: args.actor,
    plainSummary: args.summary,
  });
}

/**
 * Verify an approval covers EXACTLY the mutation about to run. Fail-closed:
 * missing / unknown / non-approved / expired / binding-mismatched approvals
 * all throw OpsGateError — the mutation must not run.
 */
export async function verifyOpsApproval(
  port: OpsGatePort,
  args: {
    workspaceId: string;
    slug: string;
    entity: string;
    entityId?: string;
    mutation: Record<string, unknown>;
    approvalId: string | null | undefined;
  },
  tx?: unknown,
): Promise<OpsGateApproval> {
  if (!args.approvalId) {
    throw new OpsGateError(
      "approval_required",
      `${args.slug} is a gated write: an approved ops approval is required (money is a red lane)`,
    );
  }
  let approval: OpsGateApproval;
  try {
    approval = await port.getApproval(args.workspaceId, args.approvalId, tx);
  } catch (err) {
    // Only a genuine miss is "not found"; anything else (pool timeout, DB
    // outage) must surface as itself, not as a misleading gate verdict.
    if (err instanceof NotFoundError) {
      throw new OpsGateError("approval_not_found", `Ops approval ${args.approvalId} not found in workspace`);
    }
    throw err;
  }
  if (approval.status === "executed") {
    throw new OpsGateError("approval_replayed", "Approval already executed — replay blocked");
  }
  if (approval.status !== "approved") {
    throw new OpsGateError(
      "approval_not_approved",
      `Cannot execute: approval is ${approval.status} (must be approved)`,
    );
  }
  if (approval.expiresAt.getTime() < Date.now()) {
    throw new OpsGateError("approval_expired", "Cannot execute: approval expired");
  }
  const expected = canonicalize(
    opsBindingFor({ entity: args.entity, entityId: args.entityId, slug: args.slug, mutation: args.mutation }),
  );
  const actual = canonicalize((approval.proposedArgs ?? {}) as Record<string, unknown>);
  if (expected !== actual) {
    throw new OpsGateError(
      "binding_mismatch",
      "Approval binding does not match this mutation — execution HALTED",
    );
  }
  return approval;
}

// ---------------------------------------------------------------------------
// Consume: the atomic approved → executed claim (replay lock).
// ---------------------------------------------------------------------------

interface ApprovalReadTx {
  composioActionApproval: {
    findFirst(args: { where: { id: string; workspaceId: string } }): Promise<{
      id: string;
      status: string;
      expiresAt: Date;
      proposedArgs: unknown;
      auditTrail: unknown;
    } | null>;
  };
}

interface ApprovalClaimTx {
  composioActionApproval: {
    updateMany(args: unknown): Promise<{ count: number }>;
  };
}

/**
 * Claim a verified approval for execution. MUST run inside the transaction
 * that performs the gated write, BEFORE the write: the status-guarded
 * updateMany row-locks the approval, so a concurrent second request blocks
 * until the first commits and then matches 0 rows. count !== 1 → the
 * approval was already executed (or expired/revoked in between) — fail
 * closed, nothing is written.
 */
export async function consumeOpsApproval(
  tx: unknown,
  args: { workspaceId: string; approval: OpsGateApproval; actor: string; slug: string },
): Promise<void> {
  const now = new Date();
  const prior = Array.isArray(args.approval.auditTrail) ? args.approval.auditTrail : [];
  const claimed = await (tx as ApprovalClaimTx).composioActionApproval.updateMany({
    where: {
      id: args.approval.id,
      workspaceId: args.workspaceId,
      status: "approved",
      expiresAt: { gt: now },
    },
    data: {
      status: "executed",
      auditTrail: [
        ...prior,
        { at: now.toISOString(), actor: args.actor, event: "execution_claimed", detail: `ops ${args.slug}` },
      ],
    },
  });
  if (claimed.count !== 1) {
    throw new OpsGateError("approval_replayed", "Approval already executed — replay blocked");
  }
}

/** verifyOpsApproval + consumeOpsApproval: the only way a gated ops write may proceed. */
export async function verifyAndConsumeOpsApproval(
  port: OpsGatePort,
  tx: unknown,
  args: Parameters<typeof verifyOpsApproval>[1] & { actor: string },
): Promise<OpsGateApproval> {
  const { actor, ...verifyArgs } = args;
  const approval = await verifyOpsApproval(port, verifyArgs, tx);
  await consumeOpsApproval(tx, { workspaceId: args.workspaceId, approval, actor, slug: args.slug });
  return approval;
}
