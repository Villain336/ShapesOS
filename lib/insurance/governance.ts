// Marketr — Wave 2 Insurance slice 3a: governed-action approval + audit framework.
//
// SPEC-INSURANCE.md §4.3–4.4. Tico's binding decisions:
// - Licensed partner holds the licenses; Marketr provides the software.
// - Money red-lane: premiums = propose → explicit human approval → licensed
//   rail executes. Zero custody. No invented coverage ("not confirmed").
// - No auto-bind in v1: bind_policy requires explicit per-transaction human
//   approval — a standing rule for bind_policy is a hard refusal.
// - E-sign-style invariant for this domain: the agent prepares, the human
//   approves, the licensed rail executes.
//
// Reuses the repo's existing approval framework (lib/messaging/approvals.ts:
// requestApproval/decideApproval) on the generic ApprovalItem Prisma model —
// no parallel approval system. Insurance kinds:
//   "insurance_request_quote" | "insurance_bind_policy" | "insurance_issue_certificate"
//
// Persistence-agnostic like partner.ts: pure rules plus store ports (Prisma
// default, stubs in tests). Every decision (approved OR denied) writes an
// InsuranceAuditEvent: who approved, what was approved (payload snapshot),
// timestamp, and the vendor transaction ref once the licensed rail executes.

import { InsuranceError } from "./types";
import { LINE_LABELS, type InsuranceLineOfBusiness } from "./types";
import { decideApproval, requestApproval } from "@/lib/messaging/approvals";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Domain.
// ---------------------------------------------------------------------------

export const GOVERNED_ACTIONS = [
  "request_quote",
  "bind_policy",
  "issue_certificate",
] as const;

export type GovernedAction = (typeof GOVERNED_ACTIONS)[number];

export const SUBJECT_TYPES = ["quote", "policy", "certificate"] as const;
export type GovernedSubjectType = (typeof SUBJECT_TYPES)[number];

/** ApprovalItem.kind for each governed action. */
export function approvalKindForAction(action: GovernedAction): string {
  return `insurance_${action}`;
}

export function actionForApprovalKind(kind: string): GovernedAction | null {
  for (const action of GOVERNED_ACTIONS) {
    if (approvalKindForAction(action) === kind) return action;
  }
  return null;
}

export function assertGovernedAction(action: string): asserts action is GovernedAction {
  if (!(GOVERNED_ACTIONS as readonly string[]).includes(action)) {
    throw new InsuranceError(
      "UNKNOWN_GOVERNED_ACTION",
      `Unknown governed action "${action}". Expected one of: ${GOVERNED_ACTIONS.join(", ")}.`,
    );
  }
}

export function assertSubjectType(
  subjectType: string,
): asserts subjectType is GovernedSubjectType {
  if (!(SUBJECT_TYPES as readonly string[]).includes(subjectType)) {
    throw new InsuranceError(
      "UNKNOWN_GOVERNED_SUBJECT",
      `Unknown governed subject type "${subjectType}". Expected one of: ${SUBJECT_TYPES.join(", ")}.`,
    );
  }
}

export interface GovernedActionSubject {
  subjectType: GovernedSubjectType;
  subjectId: string;
}

/**
 * The detail snapshot attached to the approval and carried into the audit
 * record. Fields not present at approval read "not confirmed" at render —
 * never invented. For bind_policy the disclosure fields are required (fail
 * closed): full premium, limits, carrier, and effective dates must be shown
 * to the approver before approval.
 */
export interface GovernedActionDetails {
  carrier?: string | null;
  premiumCents?: number | null;
  limitPerOccurrenceCents?: number | null;
  limitAggregateCents?: number | null;
  effectiveDate?: string | null;
  expiryDate?: string | null;
  lineOfBusiness?: string | null;
  holderName?: string | null;
  /** request_quote only: covered by a standing rule instead of this approval. */
  standingRuleCovered?: boolean;
  [key: string]: unknown;
}

export interface ApprovalRecord {
  id: string;
  workspaceId: string;
  kind: string;
  payload: unknown;
  status: string;
  requestedBy: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  note: string | null;
  /** Optional: populated by the Prisma port for the approval queue UI ("when"). */
  createdAt?: Date | null;
}

export interface AuditEventRecord {
  id: string;
  workspaceId: string;
  action: GovernedAction;
  subjectType: GovernedSubjectType;
  subjectId: string;
  result: "approved" | "denied";
  decidedBy: string | null;
  decidedAt: Date;
  payload: unknown;
  vendorTransactionRef: string | null;
  note: string | null;
}

export interface QuoteRuleRecord {
  id: string;
  workspaceId: string;
  lineOfBusiness: string;
  approvedBy: string | null;
  createdAt: Date;
}

/**
 * Fail closed on bind disclosure: the approver must see the full premium,
 * limits, carrier, and effective dates before a bind approval. A bind
 * proposal missing any of these cannot be presented for approval.
 */
export function validateBindDisclosure(details: GovernedActionDetails): void {
  const missing: string[] = [];
  if (!details.carrier) missing.push("carrier");
  if (details.premiumCents == null) missing.push("premiumCents");
  if (details.limitPerOccurrenceCents == null)
    missing.push("limitPerOccurrenceCents");
  if (details.limitAggregateCents == null) missing.push("limitAggregateCents");
  if (!details.effectiveDate) missing.push("effectiveDate");
  if (missing.length > 0) {
    throw new InsuranceError(
      "BIND_DISCLOSURE_INCOMPLETE",
      `bind_policy requires full disclosure before approval. Missing: ${missing.join(", ")}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Store ports.
// ---------------------------------------------------------------------------

export interface GovernedApprovalStore {
  create(input: {
    workspaceId: string;
    kind: string;
    payload: unknown;
    requestedBy?: string;
  }): Promise<ApprovalRecord>;
  get(id: string, workspaceId: string): Promise<ApprovalRecord | null>;
  decide(
    id: string,
    workspaceId: string,
    decision: "approve" | "reject",
    decidedBy?: string,
    note?: string,
  ): Promise<ApprovalRecord>;
  listPending(workspaceId: string, kinds: string[]): Promise<ApprovalRecord[]>;
}

export interface InsuranceAuditStore {
  create(input: {
    workspaceId: string;
    action: GovernedAction;
    subjectType: GovernedSubjectType;
    subjectId: string;
    result: "approved" | "denied";
    decidedBy: string | null;
    decidedAt: Date;
    payload: unknown;
    vendorTransactionRef?: string | null;
    note?: string | null;
  }): Promise<AuditEventRecord>;
}

export interface InsuranceQuoteRuleStore {
  find(workspaceId: string, lineOfBusiness: string): Promise<QuoteRuleRecord | null>;
  upsert(
    workspaceId: string,
    lineOfBusiness: string,
    approvedBy?: string,
  ): Promise<QuoteRuleRecord>;
  list(workspaceId: string): Promise<QuoteRuleRecord[]>;
}

function toApprovalRecord(row: {
  id: string;
  workspaceId: string;
  kind: string;
  payload: unknown;
  status: string;
  requestedBy: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  note: string | null;
  createdAt?: Date | null;
}): ApprovalRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind,
    payload: row.payload,
    status: row.status,
    requestedBy: row.requestedBy,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    note: row.note,
    createdAt: row.createdAt ?? null,
  };
}

/** Prisma-backed approval store — delegates to the existing approval
 * framework (requestApproval/decideApproval in lib/messaging/approvals.ts). */
export function prismaGovernedApprovalStore(): GovernedApprovalStore {
  return {
    async create(input) {
      const item = await requestApproval({
        workspaceId: input.workspaceId,
        kind: input.kind,
        payload: input.payload,
        requestedBy: input.requestedBy,
      });
      return toApprovalRecord(item);
    },
    async get(id, workspaceId) {
      const item = await prisma.approvalItem.findFirst({
        where: { id, workspaceId },
      });
      return item ? toApprovalRecord(item) : null;
    },
    async decide(id, workspaceId, decision, decidedBy, note) {
      const item = await decideApproval(id, workspaceId, decision, decidedBy, note);
      return toApprovalRecord(item);
    },
    async listPending(workspaceId, kinds) {
      const items = await prisma.approvalItem.findMany({
        where: { workspaceId, status: "pending", kind: { in: kinds } },
        orderBy: { createdAt: "asc" },
      });
      return items.map(toApprovalRecord);
    },
  };
}

function toAuditRecord(row: {
  id: string;
  workspaceId: string;
  action: GovernedAction;
  subjectType: GovernedSubjectType;
  subjectId: string;
  result: "approved" | "denied";
  decidedBy: string | null;
  decidedAt: Date;
  payload: unknown;
  vendorTransactionRef: string | null;
  note: string | null;
}): AuditEventRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    action: row.action,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    result: row.result,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    payload: row.payload,
    vendorTransactionRef: row.vendorTransactionRef,
    note: row.note,
  };
}

export function prismaInsuranceAuditStore(): InsuranceAuditStore {
  return {
    async create(input) {
      const row = await prisma.insuranceAuditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          action: input.action,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          result: input.result,
          decidedBy: input.decidedBy,
          decidedAt: input.decidedAt,
          payload: (input.payload ?? {}) as object,
          vendorTransactionRef: input.vendorTransactionRef ?? null,
          note: input.note ?? null,
        },
      });
      return toAuditRecord({
        ...row,
        action: row.action as GovernedAction,
        subjectType: row.subjectType as GovernedSubjectType,
        result: row.result as "approved" | "denied",
      });
    },
  };
}

function toQuoteRuleRecord(row: {
  id: string;
  workspaceId: string;
  lineOfBusiness: string;
  approvedBy: string | null;
  createdAt: Date;
}): QuoteRuleRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    lineOfBusiness: row.lineOfBusiness,
    approvedBy: row.approvedBy,
    createdAt: row.createdAt,
  };
}

export function prismaInsuranceQuoteRuleStore(): InsuranceQuoteRuleStore {
  return {
    async find(workspaceId, lineOfBusiness) {
      const row = await prisma.insuranceQuoteRule.findUnique({
        where: { workspaceId_lineOfBusiness: { workspaceId, lineOfBusiness } },
      });
      return row ? toQuoteRuleRecord(row) : null;
    },
    async upsert(workspaceId, lineOfBusiness, approvedBy) {
      const row = await prisma.insuranceQuoteRule.upsert({
        where: { workspaceId_lineOfBusiness: { workspaceId, lineOfBusiness } },
        update: { approvedBy: approvedBy ?? null },
        create: { workspaceId, lineOfBusiness, approvedBy: approvedBy ?? null },
      });
      return toQuoteRuleRecord(row);
    },
    async list(workspaceId) {
      const rows = await prisma.insuranceQuoteRule.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(toQuoteRuleRecord);
    },
  };
}

// ---------------------------------------------------------------------------
// Governance operations.
// ---------------------------------------------------------------------------

export interface GovernanceStores {
  approvals: GovernedApprovalStore;
  audit: InsuranceAuditStore;
  quoteRules: InsuranceQuoteRuleStore;
}

export function prismaGovernanceStores(): GovernanceStores {
  return {
    approvals: prismaGovernedApprovalStore(),
    audit: prismaInsuranceAuditStore(),
    quoteRules: prismaInsuranceQuoteRuleStore(),
  };
}

/**
 * Propose a governed action: the agent prepares, the human approves. Creates
 * an ApprovalItem (via the existing approval framework) and returns it.
 * Execution must wait for an explicit decision (decideGovernedAction), and
 * the licensed rail executes only after approval.
 */
export async function proposeGovernedAction(
  workspaceId: string,
  action: string,
  subject: { subjectType: string; subjectId: string },
  details: GovernedActionDetails,
  requestedBy?: string,
  stores: GovernanceStores = prismaGovernanceStores(),
): Promise<ApprovalRecord> {
  assertGovernedAction(action);
  assertSubjectType(subject.subjectType);
  if (!subject.subjectId || subject.subjectId.trim().length === 0) {
    throw new InsuranceError("SUBJECT_ID_REQUIRED", "A governed action needs a subject id.");
  }
  if (action === "bind_policy") {
    // Fail closed: the approver must see full premium, limits, carrier, and
    // effective dates before a bind approval can even be proposed.
    validateBindDisclosure(details);
  }
  return stores.approvals.create({
    workspaceId,
    kind: approvalKindForAction(action),
    payload: {
      action,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId.trim(),
      ...details,
    },
    requestedBy,
  });
}

function approvalPayloadFields(
  kind: string,
  payload: unknown,
): {
  action: GovernedAction;
  subjectType: GovernedSubjectType;
  subjectId: string;
} {
  const p = (payload ?? {}) as Record<string, unknown>;
  const action = p["action"];
  const subjectType = p["subjectType"];
  const subjectId = p["subjectId"];
  if (
    typeof action !== "string" ||
    !(GOVERNED_ACTIONS as readonly string[]).includes(action) ||
    approvalKindForAction(action as GovernedAction) !== kind
  ) {
    // Not one of ours — fail closed rather than auditing the wrong action.
    throw new InsuranceError(
      "APPROVAL_KIND_MISMATCH",
      "This approval is not an insurance governed action.",
    );
  }
  assertGovernedAction(action);
  if (typeof subjectType !== "string") {
    throw new InsuranceError("APPROVAL_PAYLOAD_CORRUPT", "Governed approval payload is missing subjectType.");
  }
  assertSubjectType(subjectType);
  if (typeof subjectId !== "string" || subjectId.trim().length === 0) {
    throw new InsuranceError("APPROVAL_PAYLOAD_CORRUPT", "Governed approval payload is missing subjectId.");
  }
  return { action, subjectType, subjectId: subjectId.trim() };
}

/**
 * Decide a governed action (approve or reject). Enforces the transition:
 * only pending items are decidable, and deciding twice fails. Every decision
 * — approved or denied — writes an InsuranceAuditEvent (who/what/timestamp).
 * Execution (and the vendor transaction ref) happens after this, on the
 * licensed rail; the audit record's vendorTransactionRef stays null until then.
 */
export async function decideGovernedAction(
  approvalId: string,
  workspaceId: string,
  decision: "approve" | "reject",
  decidedBy?: string,
  note?: string,
  stores: GovernanceStores = prismaGovernanceStores(),
): Promise<{ approval: ApprovalRecord; audit: AuditEventRecord }> {
  const existing = await stores.approvals.get(approvalId, workspaceId);
  if (!existing) {
    throw new InsuranceError("APPROVAL_NOT_FOUND", "Governed approval not found in this workspace.");
  }
  // Enforce the insurance vocabulary: this path decides only insurance
  // governed actions, never another domain's approvals.
  const fields = approvalPayloadFields(existing.kind, existing.payload);
  if (existing.status !== "pending") {
    throw new InsuranceError(
      "APPROVAL_NOT_PENDING",
      `Governed approval is already ${existing.status}; only pending approvals are decidable.`,
    );
  }
  const decided = await stores.approvals.decide(
    approvalId,
    workspaceId,
    decision,
    decidedBy,
    note,
  );
  if (!decided.decidedAt) {
    throw new InsuranceError("APPROVAL_NOT_DECIDED", "Approval decision did not record a timestamp.");
  }
  const audit = await stores.audit.create({
    workspaceId,
    action: fields.action,
    subjectType: fields.subjectType,
    subjectId: fields.subjectId,
    result: decision === "approve" ? "approved" : "denied",
    decidedBy: decided.decidedBy,
    decidedAt: decided.decidedAt,
    payload: decided.payload,
    vendorTransactionRef: null,
    note: decided.note,
  });
  return { approval: decided, audit };
}

/** Pending governed approvals for a workspace, optionally filtered to one action. */
export async function getPendingApprovals(
  workspaceId: string,
  action?: string,
  stores: GovernanceStores = prismaGovernanceStores(),
): Promise<ApprovalRecord[]> {
  const kinds = action
    ? (() => {
        assertGovernedAction(action);
        return [approvalKindForAction(action)];
      })()
    : GOVERNED_ACTIONS.map(approvalKindForAction);
  return stores.approvals.listPending(workspaceId, kinds);
}

/**
 * Standing rule for request_quote: a workspace may pre-approve quoting per
 * line of business, so request_quote needs one approval OR a standing rule.
 *
 * HARD REFUSAL: bind_policy NEVER has a standing rule. No auto-bind in v1 —
 * every bind needs explicit per-transaction human approval. This refusal is
 * unconditional and cannot be overridden by configuration.
 */
export async function proposeStandingRule(
  workspaceId: string,
  action: string,
  lineOfBusiness: string,
  approvedBy?: string,
  stores: GovernanceStores = prismaGovernanceStores(),
): Promise<QuoteRuleRecord> {
  assertGovernedAction(action);
  if (action !== "request_quote") {
    throw new InsuranceError(
      "STANDING_RULE_REFUSED",
      `Standing rules are request_quote only. ${action} requires explicit ` +
        "per-transaction human approval; no standing auto-approval in v1.",
    );
  }
  const lob = lineOfBusiness.trim();
  if (!(lob in LINE_LABELS)) {
    throw new InsuranceError(
      "BAD_LINE_OF_BUSINESS",
      `Unknown line of business "${lineOfBusiness}".`,
    );
  }
  return stores.quoteRules.upsert(workspaceId, lob, approvedBy);
}

/** True when a request_quote for this line is covered by a standing rule. */
export async function requestQuoteCovered(
  workspaceId: string,
  lineOfBusiness: string,
  stores: GovernanceStores = prismaGovernanceStores(),
): Promise<boolean> {
  const rule = await stores.quoteRules.find(workspaceId, lineOfBusiness.trim());
  return rule !== null;
}

export type { InsuranceLineOfBusiness };
