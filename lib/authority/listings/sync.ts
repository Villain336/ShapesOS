// Marketr — Phase 6 L1: sync executor.
//
// Processes queued listing_sync_jobs in cap order (scheduledAt ascending).
// EVERY profile edit requires an approved listing_edit approval, and the
// executor re-verifies the exact binding at execution time via
// authorityApprovals.execute() — which HALTS on mismatch. A binding
// mismatch marks the job failed; it never publishes.

import { authorityApprovals } from "../db";
import { authorityAudit } from "../db";
import { listingEditBinding, type GbpEditRequest } from "./gbp";
import type { GbpClient } from "../fake";
import type { ListingStore } from "./memory";

export interface SyncExecutionResult {
  processed: number;
  succeeded: number;
  failed: number;
  /** Jobs halted by binding mismatch — never executed. */
  halted: number;
  details: { jobId: string; outcome: "executed" | "failed" | "halted"; message?: string }[];
}

export interface SyncExecutorDeps {
  store: ListingStore;
  approvals?: typeof authorityApprovals;
  client: GbpClient;
  /** "now" for due-job selection; defaults to the real clock. */
  now?: Date;
}

/**
 * Execute due queued sync jobs for a workspace, in cap order.
 *
 * Per job:
 *  1. approvalId must exist (approval-bound by construction at enqueue).
 *  2. authorityApprovals.execute() re-verifies the binding — on mismatch the
 *     approval store logs execution_halted and throws; the job is marked
 *     failed as "halted" and the payload NEVER reaches the provider.
 *  3. On binding success, the payload goes to the provider client.
 */
export async function processDueSyncJobs(
  workspaceId: string,
  deps: SyncExecutorDeps,
): Promise<SyncExecutionResult> {
  const approvals = deps.approvals ?? authorityApprovals;
  const now = deps.now ?? new Date();
  const due = await deps.store.jobs.listDue(workspaceId, now);

  const result: SyncExecutionResult = {
    processed: 0, succeeded: 0, failed: 0, halted: 0, details: [],
  };

  for (const job of due) {
    result.processed += 1;
    try {
      if (!job.approvalId) {
        await deps.store.jobs.markFailed(job.id, workspaceId, "No listing_edit approval bound — execution refused.");
        result.failed += 1;
        result.details.push({ jobId: job.id, outcome: "failed", message: "missing approval" });
        continue;
      }
      const edit: GbpEditRequest = job.payloadJson;
      const binding = listingEditBinding(edit);
      // Binding re-verification: throws ApprovalError("Binding mismatch — execution HALTED...") on mismatch.
      await approvals.execute(job.approvalId, workspaceId, binding);

      const res = await deps.client.syncProfile(edit.locationRef, edit.payload);
      if (!res.ok) throw new Error("Provider syncProfile returned ok=false.");
      await deps.store.jobs.markExecuted(job.id, workspaceId);
      await authorityAudit.logAsync({
        workspaceId, actor: "sync-executor", action: "listing_sync_executed",
        entityType: "listing_sync_job", entityId: job.id,
        detail: { profileId: job.profileId, approvalId: job.approvalId, kind: edit.kind },
      }).catch(() => undefined);
      result.succeeded += 1;
      result.details.push({ jobId: job.id, outcome: "executed" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const halted = /binding mismatch/i.test(message);
      await deps.store.jobs.markFailed(job.id, workspaceId, message);
      if (halted) {
        result.halted += 1;
        result.details.push({ jobId: job.id, outcome: "halted", message });
      } else {
        result.failed += 1;
        result.details.push({ jobId: job.id, outcome: "failed", message });
      }
    }
  }
  return result;
}
