// Marketr — Phase 5 buying paths: approval executability pre-flight.
//
// Consumes the safety track's lib/media/approvals.ts + ./safety — the
// buying paths' own fail-closed check before packet compile or executor
// dispatch. The canonical enforcement lives in the safety track's execute
// pipeline (POST /api/media/buys/:id/execute); this is defense-in-depth
// so a packet or executor run can never start from a non-executable
// approval.

import { verifyBinding, type MediaApproval } from "./approvals";
import { isApprovalExpired } from "./safety";

/**
 * Portable binding-state assertions. Mirrors the S3 pre-flight (SPEC §S3).
 * Throws on any failure with a message naming the failed assertion.
 */
export function assertApprovalExecutable(approval: MediaApproval, now = new Date()): void {
  if (approval.status !== "approved") {
    throw new Error(
      `Approval ${approval.id} is "${approval.status}" — only "approved" buys execute.`,
    );
  }
  if (approval.revokedAt) {
    throw new Error(`Approval ${approval.id} was revoked — never execute.`);
  }
  if (approval.executedAt) {
    throw new Error(`Approval ${approval.id} already executed — no double-spend.`);
  }
  if (!approval.twoPersonSatisfied) {
    throw new Error(
      `Approval ${approval.id} lacks two-person provenance (creator ≠ approver).`,
    );
  }
  if (isApprovalExpired(approval.approvalsExpiresAt, now)) {
    throw new Error(
      `Approval ${approval.id} expired — stale approvals never execute; re-approval required.`,
    );
  }
  // Quote-then-book (IAB pattern): direct deals need a live, unexpired quote.
  if (approval.binding.dealType !== "auction") {
    const exp =
      approval.quoteExpiresAt ??
      (approval.binding.quoteExpiresAt ? new Date(approval.binding.quoteExpiresAt) : null);
    if (!exp || exp <= now) {
      throw new Error(
        `Approval ${approval.id} has an expired or missing quote — re-quote before booking (quote-then-book).`,
      );
    }
  }
  const b = approval.binding;
  if (!Number.isInteger(b.maxTotalSpendCents) || b.maxTotalSpendCents <= 0) {
    throw new Error(
      `Approval ${approval.id} has no positive max total spend — binding is total or it is not a buy.`,
    );
  }
  // Binding hash — the TOCTOU kill switch (constant-time compare).
  if (!verifyBinding(b, approval.bindingHash)) {
    throw new Error(
      `Approval ${approval.id} binding hash mismatch — the binding changed post-approval. Re-approval required.`,
    );
  }
}
