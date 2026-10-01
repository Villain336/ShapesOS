// Marketr — Wave 2 Insurance slice 4: renewal remarketing workflow.
//
// SPEC-INSURANCE.md §4.3 (renew governed action):
// - remarketing a renewal requires request_quote gating;
// - binding the renewal quote requires the bind_policy gate;
// - auto-renewals are detected and surfaced, NEVER silently accepted — the
//   agent compares renewal terms against prior term and flags premium or
//   coverage deltas above a threshold before asking for approval.
//
// Persistence-agnostic like governance.ts/partner.ts: pure rules plus store
// ports (Prisma default, stubs in tests). Money red-lane: this file never
// binds anything — binding stays in the slice-3b execution path behind the
// bind_policy gate and the licensed rail.

import type { Prisma } from "@prisma/client";
import { InsuranceSubmissionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  LINE_LABELS,
  deltaExceedsThreshold,
  isValidRemarketTransition,
  premiumDeltaPct,
  InsuranceError,
  type InsuranceLineOfBusiness,
  type InsuranceRemarketStatus,
} from "./types";
import { deriveSubmissionStatus } from "./quoting";
export type { ApprovalRecord, GovernanceStores } from "./governance";
import {
  approvalKindForAction,
  proposeGovernedAction,
  requestQuoteCovered,
  type ApprovalRecord,
  type GovernanceStores,
  prismaGovernanceStores,
} from "./governance";
import { CoverForceVendor } from "./coverforce";
import type { InsuranceVendor } from "./mock-vendor";

// ---------------------------------------------------------------------------
// Domain records.
// ---------------------------------------------------------------------------

export interface RenewalPolicySnapshot {
  id: string;
  policyNumber: string;
  line: InsuranceLineOfBusiness;
  namedInsured: string;
  carrierName: string | null;
  limitPerOccurrenceCents: number | null;
  limitAggregateCents: number | null;
  annualPremiumCents: number | null;
  effectiveAt: Date;
  expiresAt: Date;
}

export interface RenewalRecord {
  id: string;
  workspaceId: string;
  policyId: string;
  renewalDate: Date;
  remarketStatus: InsuranceRemarketStatus;
  priorPremiumCents: number | null;
  newPremiumCents: number | null;
  premiumDeltaPct: number | null;
  autoRenewTerms: unknown;
  policy: RenewalPolicySnapshot | null;
}

export interface RemarketSubmissionRecord {
  id: string;
  workspaceId: string;
  renewalId: string | null;
  line: string;
  applicantName: string;
  state: string;
  status: string;
  vendorRef: string | null;
  submittedBy: string;
}

export interface RemarketQuoteLite {
  id: string;
  carrierName: string;
  quotedPremiumCents: number | null;
  limitPerOccurrenceCents: number | null;
  limitAggregateCents: number | null;
  status: string;
}

export interface RenewalUpdate {
  remarketStatus?: InsuranceRemarketStatus;
  newPremiumCents?: number | null;
  premiumDeltaPct?: number | null;
  autoRenewTerms?: unknown;
}

export interface SubmissionCreateInput {
  workspaceId: string;
  renewalId: string;
  line: InsuranceLineOfBusiness;
  applicantName: string;
  operationsDescription: string | null;
  state: string;
  classCode: string | null;
  payrollCents: number | null;
  revenueCents: number | null;
  targetLimitPerOccurrenceCents: number | null;
  targetLimitAggregateCents: number | null;
  lossHistory: unknown[];
  status: "draft";
  submittedBy: string;
}

export interface SubmissionUpdate {
  status?: string;
  vendorRef?: string | null;
}

export interface PersistedVendorQuote {
  carrierName: string;
  quotedPremiumCents: number | null;
  limitPerOccurrenceCents: number | null;
  limitAggregateCents: number | null;
  quoteExpiry: Date | null;
  status: "quoted" | "declined" | "referred";
  vendorNotes: string | null;
}

// ---------------------------------------------------------------------------
// Store ports.
// ---------------------------------------------------------------------------

export interface RenewalStore {
  get(id: string, workspaceId: string): Promise<RenewalRecord | null>;
  update(
    id: string,
    workspaceId: string,
    data: RenewalUpdate,
  ): Promise<RenewalRecord>;
  findSubmissionForRenewal(
    renewalId: string,
    workspaceId: string,
  ): Promise<RemarketSubmissionRecord | null>;
  createSubmission(input: SubmissionCreateInput): Promise<RemarketSubmissionRecord>;
  updateSubmission(
    id: string,
    workspaceId: string,
    data: SubmissionUpdate,
  ): Promise<RemarketSubmissionRecord>;
  listQuotesBySubmission(
    submissionId: string,
    workspaceId: string,
  ): Promise<RemarketQuoteLite[]>;
  createQuotes(
    submissionId: string,
    workspaceId: string,
    quotes: PersistedVendorQuote[],
  ): Promise<void>;
}

/**
 * Gate lookups the generic GovernedApprovalStore does not carry: the
 * request_quote approval covering a specific submission.
 */
export interface RenewalGateLookups {
  findApprovedRequestQuote(
    workspaceId: string,
    submissionId: string,
  ): Promise<ApprovalRecord | null>;
}

export interface RenewalStores {
  renewals: RenewalStore;
  governance: GovernanceStores;
  gates: RenewalGateLookups;
}

type RenewalRow = Prisma.InsuranceRenewalGetPayload<{
  include: { policy: { include: { carrier: { select: { name: true } } } } };
}>;

export function toRenewalRecord(row: RenewalRow): RenewalRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    policyId: row.policyId,
    renewalDate: row.renewalDate,
    remarketStatus: row.remarketStatus as InsuranceRemarketStatus,
    priorPremiumCents: row.priorPremiumCents,
    newPremiumCents: row.newPremiumCents,
    premiumDeltaPct: row.premiumDeltaPct,
    autoRenewTerms: row.autoRenewTerms ?? null,
    policy: row.policy
      ? {
          id: row.policy.id,
          policyNumber: row.policy.policyNumber,
          line: row.policy.line as InsuranceLineOfBusiness,
          namedInsured: row.policy.namedInsured,
          carrierName: row.policy.carrier?.name ?? null,
          limitPerOccurrenceCents: row.policy.limitPerOccurrenceCents,
          limitAggregateCents: row.policy.limitAggregateCents,
          annualPremiumCents: row.policy.annualPremiumCents,
          effectiveAt: row.policy.effectiveAt,
          expiresAt: row.policy.expiresAt,
        }
      : null,
  };
}

function toSubmissionRecord(row: {
  id: string;
  workspaceId: string;
  renewalId: string | null;
  line: string;
  applicantName: string;
  state: string;
  status: string;
  vendorRef: string | null;
  submittedBy: string;
}): RemarketSubmissionRecord {
  return { ...row };
}

function toQuoteLite(row: {
  id: string;
  carrierName: string;
  quotedPremiumCents: number | null;
  limitPerOccurrenceCents: number | null;
  limitAggregateCents: number | null;
  status: string;
}): RemarketQuoteLite {
  return { ...row };
}

const RENEWAL_INCLUDE = {
  policy: { include: { carrier: { select: { name: true } } } },
} as const;

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

/** Prisma-backed store ports. */
export function prismaRenewalStore(): RenewalStore {
  return {
    async get(id, workspaceId) {
      const row = await prisma.insuranceRenewal.findFirst({
        where: { id, workspaceId },
        include: RENEWAL_INCLUDE,
      });
      return row ? toRenewalRecord(row) : null;
    },
    async update(id, workspaceId, data) {
      const row = await prisma.insuranceRenewal.update({
        where: { id, workspaceId },
        data: {
          ...(data.remarketStatus !== undefined
            ? { remarketStatus: data.remarketStatus }
            : {}),
          ...(data.newPremiumCents !== undefined
            ? { newPremiumCents: data.newPremiumCents }
            : {}),
          ...(data.premiumDeltaPct !== undefined
            ? { premiumDeltaPct: data.premiumDeltaPct }
            : {}),
          ...(data.autoRenewTerms !== undefined
            ? { autoRenewTerms: (data.autoRenewTerms ?? {}) as object }
            : {}),
        },
        include: RENEWAL_INCLUDE,
      });
      return toRenewalRecord(row);
    },
    async findSubmissionForRenewal(renewalId, workspaceId) {
      const row = await prisma.insuranceSubmission.findFirst({
        where: { renewalId, workspaceId },
        orderBy: { createdAt: "desc" },
      });
      return row ? toSubmissionRecord(row) : null;
    },
    async createSubmission(input) {
      const row = await prisma.insuranceSubmission.create({
        data: {
          workspaceId: input.workspaceId,
          renewalId: input.renewalId,
          line: input.line,
          applicantName: input.applicantName,
          operationsDescription: input.operationsDescription,
          state: input.state,
          classCode: input.classCode,
          payrollCents: input.payrollCents,
          revenueCents: input.revenueCents,
          targetLimitPerOccurrenceCents: input.targetLimitPerOccurrenceCents,
          targetLimitAggregateCents: input.targetLimitAggregateCents,
          lossHistory: input.lossHistory as Prisma.InputJsonValue,
          status: input.status,
          submittedBy: input.submittedBy,
        },
      });
      return toSubmissionRecord(row);
    },
    async updateSubmission(id, workspaceId, data) {
      const row = await prisma.insuranceSubmission.update({
        where: { id, workspaceId },
        data: {
          ...(data.status !== undefined
            ? { status: data.status as InsuranceSubmissionStatus }
            : {}),
          ...(data.vendorRef !== undefined ? { vendorRef: data.vendorRef } : {}),
        },
      });
      return toSubmissionRecord(row);
    },
    async listQuotesBySubmission(submissionId, workspaceId) {
      const rows = await prisma.insuranceQuote.findMany({
        where: { submissionId, workspaceId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map((r) =>
        toQuoteLite({
          id: r.id,
          carrierName: r.carrierName,
          quotedPremiumCents: r.quotedPremiumCents,
          limitPerOccurrenceCents: r.limitPerOccurrenceCents,
          limitAggregateCents: r.limitAggregateCents,
          status: r.status,
        }),
      );
    },
    async createQuotes(submissionId, workspaceId, quotes) {
      await prisma.insuranceQuote.createMany({
        data: quotes.map((q) => ({
          workspaceId,
          submissionId,
          carrierName: q.carrierName,
          quotedPremiumCents: q.quotedPremiumCents,
          limitPerOccurrenceCents: q.limitPerOccurrenceCents,
          limitAggregateCents: q.limitAggregateCents,
          quoteExpiry: q.quoteExpiry,
          status: q.status,
          vendorNotes: q.vendorNotes,
          rawPayload: { fixture: true, vendor: "coverforce", renewal: true },
        })),
      });
    },
  };
}

export function prismaRenewalGateLookups(): RenewalGateLookups {
  return {
    async findApprovedRequestQuote(workspaceId, submissionId) {
      const item = await prisma.approvalItem.findFirst({
        where: {
          workspaceId,
          kind: approvalKindForAction("request_quote"),
          status: "approved",
          payload: { path: ["subjectId"], equals: submissionId },
        },
        orderBy: { decidedAt: "desc" },
      });
      return item ? toApprovalRecord(item) : null;
    },
  };
}

export function prismaRenewalStores(): RenewalStores {
  return {
    renewals: prismaRenewalStore(),
    governance: prismaGovernanceStores(),
    gates: prismaRenewalGateLookups(),
  };
}

// ---------------------------------------------------------------------------
// Status vocabulary.
// ---------------------------------------------------------------------------

const REMARKET_STATUSES = [
  "detected",
  "remarketing",
  "quoted",
  "bound",
  "auto_renew_surfaced",
] as const;

export function assertRemarketStatus(
  value: string,
): asserts value is InsuranceRemarketStatus {
  if (!(REMARKET_STATUSES as readonly string[]).includes(value)) {
    throw new InsuranceError(
      "UNKNOWN_RENEWAL",
      `Unknown remarket status "${value}". Expected one of: ${REMARKET_STATUSES.join(", ")}.`,
    );
  }
}

async function getRenewalOrThrow(
  workspaceId: string,
  renewalId: string,
  stores: RenewalStores,
): Promise<RenewalRecord> {
  const renewal = await stores.renewals.get(renewalId, workspaceId);
  if (!renewal) {
    throw new InsuranceError(
      "RENEWAL_NOT_FOUND",
      "Renewal not found in this workspace.",
    );
  }
  return renewal;
}

// ---------------------------------------------------------------------------
// advanceRemarket — the remarket state machine, fail closed.
//
// detected → remarketing → quoted → bound. detected → auto_renew_surfaced
// (terminal). Entering "quoted" pulls the linked submission's quotes and
// records the premium delta vs the prior term. Entering "bound" requires a
// quote of the linked submission to actually be bound (the slice-3b
// execution path sets that) — marking bound any other way is refused.
// auto_renew_surfaced can only be entered via surfaceAutoRenew with the
// carrier's terms snapshot; a bare transition is refused (it would be a
// silent acceptance).
// ---------------------------------------------------------------------------

export interface AdvanceOptions {
  stores?: RenewalStores;
  vendor?: InsuranceVendor;
}

export async function advanceRemarket(
  workspaceId: string,
  renewalId: string,
  toStatus: string,
  _actor: string,
  opts: AdvanceOptions = {},
): Promise<RenewalRecord> {
  const stores = opts.stores ?? prismaRenewalStores();
  assertRemarketStatus(toStatus);
  const renewal = await getRenewalOrThrow(workspaceId, renewalId, stores);
  if (!isValidRemarketTransition(renewal.remarketStatus, toStatus)) {
    throw new InsuranceError(
      "ILLEGAL_REMARKET_TRANSITION",
      `Cannot move renewal from ${renewal.remarketStatus} to ${toStatus}.`,
    );
  }
  if (toStatus === "auto_renew_surfaced") {
    // Fail closed: surfacing an auto-renewal requires the carrier's terms
    // snapshot. A bare transition would be a silent acceptance.
    throw new InsuranceError(
      "ILLEGAL_REMARKET_TRANSITION",
      "auto_renew_surfaced requires the carrier's terms — use surfaceAutoRenew, never a bare transition.",
    );
  }
  if (toStatus === "quoted") {
    const { renewal: updated } = await recordRenewalQuotes(workspaceId, renewalId, {
      stores,
      vendor: opts.vendor,
    });
    return updated;
  }
  if (toStatus === "bound") {
    const submission = await stores.renewals.findSubmissionForRenewal(
      renewalId,
      workspaceId,
    );
    const quotes = submission
      ? await stores.renewals.listQuotesBySubmission(submission.id, workspaceId)
      : [];
    const boundQuote = quotes.find((q) => q.status === "bound");
    if (!boundQuote) {
      throw new InsuranceError(
        "BIND_APPROVAL_REQUIRED",
        "A renewal can only be marked bound after one of its quotes is bound " +
          "through the approvals flow (propose → approve → licensed rail executes).",
      );
    }
  }
  return stores.renewals.update(renewalId, workspaceId, {
    remarketStatus: toStatus,
  });
}

// ---------------------------------------------------------------------------
// startRemarket — create the remarket submission from the expiring policy,
// behind the request_quote governed action.
//
// The submission is pre-filled from the policy (line, named insured, target
// limits). Fields the policy does not carry (operations, class codes,
// payroll, revenue) stay null — never invented. The risk's state is required
// explicitly: the policy does not record one and the OS never guesses it.
//
// request_quote is the lightest gate: one approval, OR a pre-approved
// standing rule per line of business (InsuranceQuoteRule). The submission is
// created in "draft" — quotes are pulled later by recordRenewalQuotes once
// the gate is satisfied.
// ---------------------------------------------------------------------------

export interface StartRemarketOptions {
  stores?: RenewalStores;
  /** 2-letter state of the risk. Required — the policy does not record one. */
  state?: string;
}

export interface StartRemarketResult {
  renewal: RenewalRecord;
  submission: RemarketSubmissionRecord;
  /** Null when a standing rule covered the request_quote gate. */
  approval: ApprovalRecord | null;
  standingRuleCovered: boolean;
}

export async function startRemarket(
  workspaceId: string,
  renewalId: string,
  actor: string,
  opts: StartRemarketOptions = {},
): Promise<StartRemarketResult> {
  const stores = opts.stores ?? prismaRenewalStores();
  const renewal = await getRenewalOrThrow(workspaceId, renewalId, stores);
  if (renewal.remarketStatus !== "detected") {
    throw new InsuranceError(
      "ILLEGAL_REMARKET_TRANSITION",
      `Remarket can only start from "detected" (now ${renewal.remarketStatus}).`,
    );
  }
  const existing = await stores.renewals.findSubmissionForRenewal(
    renewalId,
    workspaceId,
  );
  if (existing) {
    throw new InsuranceError(
      "ILLEGAL_REMARKET_TRANSITION",
      "This renewal already has a remarket submission.",
    );
  }
  const policy = renewal.policy;
  if (!policy) {
    throw new InsuranceError(
      "RENEWAL_POLICY_MISSING",
      "Cannot remarket: the expiring policy is not confirmed.",
    );
  }
  const state = (opts.state ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) {
    throw new InsuranceError(
      "RENEWAL_STATE_REQUIRED",
      "Starting a remarket needs the risk's 2-letter state — the expiring " +
        "policy does not record one and the OS never invents it.",
    );
  }

  const submission = await stores.renewals.createSubmission({
    workspaceId,
    renewalId,
    line: policy.line,
    applicantName: policy.namedInsured,
    operationsDescription: null,
    state,
    classCode: null,
    payrollCents: null,
    revenueCents: null,
    targetLimitPerOccurrenceCents: policy.limitPerOccurrenceCents,
    targetLimitAggregateCents: policy.limitAggregateCents,
    lossHistory: [],
    status: "draft",
    submittedBy: actor,
  });

  const standingRuleCovered = await requestQuoteCovered(
    workspaceId,
    policy.line,
    stores.governance,
  );
  let approval: ApprovalRecord | null = null;
  if (!standingRuleCovered) {
    approval = await proposeGovernedAction(
      workspaceId,
      "request_quote",
      { subjectType: "quote", subjectId: submission.id },
      {
        lineOfBusiness: LINE_LABELS[policy.line],
        renewalId,
        policyNumber: policy.policyNumber,
        standingRuleCovered: false,
      },
      actor,
      stores.governance,
    );
  }

  const updated = await stores.renewals.update(renewalId, workspaceId, {
    remarketStatus: "remarketing",
  });
  return { renewal: updated, submission, approval, standingRuleCovered };
}

// ---------------------------------------------------------------------------
// recordRenewalQuotes — pull the linked submission's quotes and compare them
// against the prior term.
//
// First pull: the request_quote gate must be satisfied before the risk goes
// to carriers — a standing rule, or an approved request_quote approval for
// this submission. Then the vendor submit runs, quotes persist, and the
// renewal records the best priced premium, the delta vs the prior term
// (pure functions from types.ts), and the above-threshold flag. Declines and
// referrals are kept on the submission — they are first-class outcomes, and
// the agent explains them in plain language.
// ---------------------------------------------------------------------------

export interface RecordQuotesOptions {
  stores?: RenewalStores;
  vendor?: InsuranceVendor;
}

export interface RecordQuotesResult {
  renewal: RenewalRecord;
  quotes: RemarketQuoteLite[];
  /** Best priced premium vs prior term exceeded the flag threshold. */
  deltaFlagged: boolean;
}

export async function recordRenewalQuotes(
  workspaceId: string,
  renewalId: string,
  opts: RecordQuotesOptions = {},
): Promise<RecordQuotesResult> {
  const stores = opts.stores ?? prismaRenewalStores();
  const renewal = await getRenewalOrThrow(workspaceId, renewalId, stores);
  if (
    renewal.remarketStatus !== "remarketing" &&
    renewal.remarketStatus !== "quoted"
  ) {
    throw new InsuranceError(
      "ILLEGAL_REMARKET_TRANSITION",
      `Quotes can only be recorded while a renewal is being remarketed (now ${renewal.remarketStatus}).`,
    );
  }
  const submission = await stores.renewals.findSubmissionForRenewal(
    renewalId,
    workspaceId,
  );
  if (!submission) {
    throw new InsuranceError(
      "NO_LINKED_SUBMISSION",
      "This renewal has no remarket submission yet — start the remarket first.",
    );
  }

  let quotes = await stores.renewals.listQuotesBySubmission(
    submission.id,
    workspaceId,
  );
  if (quotes.length === 0 && submission.status === "draft") {
    // First pull: request_quote gating. A standing rule covers the line, or
    // an approved request_quote approval must exist for this submission —
    // submitting a risk to carriers discloses business data.
    const covered = await requestQuoteCovered(
      workspaceId,
      submission.line,
      stores.governance,
    );
    const approved = covered
      ? null
      : await stores.gates.findApprovedRequestQuote(workspaceId, submission.id);
    if (!covered && !approved) {
      throw new InsuranceError(
        "REQUEST_QUOTE_NOT_APPROVED",
        "Fetching renewal quotes needs an approved request_quote governed " +
          "action or a standing quote rule for this line of business.",
      );
    }

    const vendor = opts.vendor ?? new CoverForceVendor({ mode: "fixture" });
    const { submissionRef } = await vendor.submit({
      line: submission.line as InsuranceLineOfBusiness,
      applicantName: submission.applicantName,
      state: submission.state,
      payrollCents: null,
      revenueCents: null,
    });
    const vendorQuotes = await vendor.getQuotes({ submissionRef });

    const persisted: PersistedVendorQuote[] = vendorQuotes.map((vq) => ({
      carrierName: vq.carrierName,
      quotedPremiumCents: vq.quotedPremiumCents,
      limitPerOccurrenceCents: vq.limitPerOccurrenceCents,
      limitAggregateCents: vq.limitAggregateCents,
      quoteExpiry: vq.quoteExpiry ? new Date(vq.quoteExpiry) : null,
      status:
        vq.status === "quoted"
          ? "quoted"
          : vq.status === "referred"
            ? "referred"
            : "declined",
      vendorNotes: vq.declineReason ?? null,
    }));
    await stores.renewals.createQuotes(submission.id, workspaceId, persisted);
    const derived = deriveSubmissionStatus(persisted.map((q) => q.status));
    await stores.renewals.updateSubmission(submission.id, workspaceId, {
      status: derived,
      vendorRef: submissionRef,
    });
    quotes = await stores.renewals.listQuotesBySubmission(
      submission.id,
      workspaceId,
    );
  }

  const priced = quotes.filter(
    (q) => q.status === "quoted" && q.quotedPremiumCents != null,
  );
  if (priced.length === 0) {
    throw new InsuranceError(
      "NO_RENEWAL_QUOTES",
      "No priced quotes came back for the renewal submission. Declines and " +
        "referrals are kept on the submission for review.",
    );
  }
  const prior = renewal.priorPremiumCents ?? renewal.policy?.annualPremiumCents ?? null;
  if (prior == null || prior <= 0) {
    throw new InsuranceError(
      "PRIOR_PREMIUM_UNKNOWN",
      "Cannot compare renewal quotes: the prior term's premium is not confirmed.",
    );
  }
  const best = Math.min(...priced.map((q) => q.quotedPremiumCents as number));
  const delta = premiumDeltaPct(prior, best);
  const deltaFlagged = deltaExceedsThreshold(prior, best);

  const updated = await stores.renewals.update(renewalId, workspaceId, {
    newPremiumCents: best,
    premiumDeltaPct: delta,
    remarketStatus: "quoted",
  });
  return { renewal: updated, quotes, deltaFlagged };
}

// ---------------------------------------------------------------------------
// surfaceAutoRenew — the carrier auto-renewed (or will auto-renew) the policy.
//
// Marks auto_renew_surfaced with the carrier's terms snapshot and raises a
// pending review — NEVER silently accepted. The renewal terms are compared
// against the prior term and premium deltas above the threshold are flagged
// before anyone is asked to approve the renewal. Accepting the terms still
// routes through a renewal quote + the bind_policy gate.
// ---------------------------------------------------------------------------

export interface CarrierAutoRenewTerms {
  premiumCents?: number | null;
  limitPerOccurrenceCents?: number | null;
  limitAggregateCents?: number | null;
  effectiveDate?: string | null;
  expiryDate?: string | null;
  carrierName?: string | null;
  [key: string]: unknown;
}

export interface SurfaceAutoRenewResult {
  renewal: RenewalRecord;
  deltaFlagged: boolean;
  /** Always true: surfacing IS the pending review. */
  needsReview: boolean;
}

export async function surfaceAutoRenew(
  workspaceId: string,
  renewalId: string,
  carrierTerms: CarrierAutoRenewTerms,
  opts: { stores?: RenewalStores } = {},
): Promise<SurfaceAutoRenewResult> {
  const stores = opts.stores ?? prismaRenewalStores();
  const renewal = await getRenewalOrThrow(workspaceId, renewalId, stores);
  if (renewal.remarketStatus !== "detected") {
    throw new InsuranceError(
      "ILLEGAL_REMARKET_TRANSITION",
      `Auto-renew can only be surfaced from "detected" (now ${renewal.remarketStatus}) — it is never silently accepted.`,
    );
  }
  if (
    !carrierTerms ||
    typeof carrierTerms !== "object" ||
    Object.keys(carrierTerms).length === 0
  ) {
    throw new InsuranceError(
      "AUTO_RENEW_TERMS_REQUIRED",
      "Surfacing an auto-renewal requires the carrier's terms — an empty " +
        "snapshot would be a silent acceptance.",
    );
  }

  let newPremiumCents: number | null = null;
  let delta: number | null = null;
  let deltaFlagged = false;
  const prior =
    renewal.priorPremiumCents ?? renewal.policy?.annualPremiumCents ?? null;
  const termsPremium =
    typeof carrierTerms.premiumCents === "number"
      ? carrierTerms.premiumCents
      : null;
  if (termsPremium != null && prior != null && prior > 0) {
    newPremiumCents = termsPremium;
    delta = premiumDeltaPct(prior, termsPremium);
    deltaFlagged = deltaExceedsThreshold(prior, termsPremium);
  }

  const updated = await stores.renewals.update(renewalId, workspaceId, {
    remarketStatus: "auto_renew_surfaced",
    autoRenewTerms: carrierTerms,
    ...(newPremiumCents != null
      ? { newPremiumCents, premiumDeltaPct: delta }
      : {}),
  });
  return { renewal: updated, deltaFlagged, needsReview: true };
}
