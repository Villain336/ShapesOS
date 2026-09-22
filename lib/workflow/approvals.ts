// Marketr — automation canvas: approval-queue wiring (redesign §2).
//
// The canvas does not build its own approval UI. Approval gates and draft
// actions reuse the existing autopilot approval queue by lazily creating
// per-project AutopilotRule rows ("Workflow approvals", "Workflow drafts")
// plus per-event AutopilotRun rows (status completed, createdBy "workflow"),
// then enqueueing pending AutopilotItems the existing approve/reject/publish
// routes already handle.

import type { PrismaClient } from "@prisma/client";
import { createAutopilotRule } from "@/lib/seo/autopilot-service";

type Db = PrismaClient;

/** AutopilotSource value valid for workflow-owned rules (see prisma enum). */
const WORKFLOW_SOURCE = "keyword_opportunity" as const;

async function ensureRule(db: Db, workspaceId: string, projectId: string, name: string) {
  const existing = await db.autopilotRule.findFirst({ where: { projectId, name } });
  if (existing) return existing;
  const { id } = await createAutopilotRule(db, {
    workspaceId,
    projectId,
    input: { name, source: WORKFLOW_SOURCE, cadence: "manual", maxItemsPerRun: 25 },
  });
  return db.autopilotRule.findUniqueOrThrow({ where: { id } });
}

/** Lazily ensure the per-project "Workflow approvals" rule. */
export function ensureWorkflowApprovalsRule(db: Db, workspaceId: string, projectId: string) {
  return ensureRule(db, workspaceId, projectId, "Workflow approvals");
}

/** Lazily ensure the per-project "Workflow drafts" rule (generate_draft items). */
export function ensureWorkflowDraftsRule(db: Db, workspaceId: string, projectId: string) {
  return ensureRule(db, workspaceId, projectId, "Workflow drafts");
}

export interface WorkflowItemInput {
  projectId: string;
  kind: "keyword_brief" | "decay_refresh" | "programmatic_page";
  sourceRef: string;
  title: string;
  summary?: string | null;
  draftMarkdown?: string | null;
}

/**
 * Create a pending AutopilotItem under a workflow rule, with its own
 * completed AutopilotRun (createdBy "workflow"). Idempotent per sourceRef:
 * AutopilotItem is unique on (ruleId, kind, sourceRef), so a duplicate
 * returns the existing row instead of throwing.
 */
export async function createWorkflowAutopilotItem(
  db: Db,
  rule: { id: string },
  input: WorkflowItemInput,
) {
  const existing = await db.autopilotItem.findFirst({
    where: { ruleId: rule.id, kind: input.kind, sourceRef: input.sourceRef },
  });
  if (existing) return existing;
  const run = await db.autopilotRun.create({
    data: {
      ruleId: rule.id,
      projectId: input.projectId,
      status: "completed",
      createdBy: "workflow",
      itemsGenerated: 1,
    },
  });
  return db.autopilotItem.create({
    data: {
      runId: run.id,
      ruleId: rule.id,
      projectId: input.projectId,
      kind: input.kind,
      sourceRef: input.sourceRef,
      title: input.title.slice(0, 200),
      // AutopilotItem has no summary column — the reviewer message travels
      // in reviewNote (visible in the existing approval queue UI).
      reviewNote: (input.summary ?? null)?.slice(0, 500) ?? null,
      draftMarkdown: input.draftMarkdown ?? null,
      status: "pending",
    },
  });
}

/** Canonical sourceRef for an approval gate's queue item. */
export function gateSourceRef(runId: string, nodeId: string): string {
  return `workflow_run:${runId}:${nodeId}`;
}

/** Parse a gate sourceRef back into { runId, nodeId }; null when not a workflow item. */
export function parseGateSourceRef(sourceRef: string): { runId: string; nodeId: string } | null {
  const m = /^workflow_run:([^:]+):([^:]+)$/.exec(sourceRef);
  return m ? { runId: m[1], nodeId: m[2] } : null;
}
