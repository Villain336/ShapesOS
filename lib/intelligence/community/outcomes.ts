// Marketr — Phase 10 M8: closed loop.
//
// Posted outcomes (upvotes/replies/traffic — entered by the human after
// posting NATIVELY, or via official APIs where available) are recorded in
// two places:
//   1. mission_approvals.binding_json.outcome — the queryable record
//      (numbers the human entered: postedAt, upvotes, replies, traffic).
//   2. mission_approval_events (action "community.posted") — the
//      hash-chained, append-only audit trail of the same fact.
//
// STATE DECISION (documented per the M8 brief): no new tables, no schema
// changes, no migrations. M8-specific state lives on existing rows only:
//   - drafts          → mission_approvals (action "community_reply_draft", Tier 2)
//   - outcomes        → mission_approvals.binding_json.outcome + the
//                       mission_approval_events trail
//   - tracked threads → derived from the approval items themselves
//
// Binding-hash note: mission_approvals binds bindingJson at creation via
// bindingHash. For community drafts that binding is a CREATION-TIME
// integrity record — there is no community executor that could re-verify
// it at execution time (executing would be autoposting, which M8 forbids;
// the human posts natively outside Marketr). The outcome is written as an
// ADDITIVE `outcome` key and never alters the approved draft payload keys
// (source/thread/reason/draft/threadUrl), so "what was approved" stays
// byte-identical under the original hash.

import { withWorkspaceScope, type TxClient } from "@/lib/substrate/graph/rls";
import { appendApprovalEvent } from "@/lib/automation/decide";
import type { Prisma } from "@prisma/client";
import {
  COMMUNITY_DRAFT_ACTION,
  COMMUNITY_POSTED_EVENT,
  type CommunityOutcome,
  type CommunityOutcomeInput,
  type CommunitySourceId,
} from "./types";

export interface StoredOutcome {
  postedAt: string;
  upvotes: number | null;
  replies: number | null;
  traffic: number | null;
  note: string | null;
  recordedBy: string;
  recordedAt: string;
}

function sanitizeOutcome(input: CommunityOutcomeInput): StoredOutcome {
  const num = (v: number | null | undefined): number | null =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
  return {
    postedAt: input.postedAt ?? new Date().toISOString(),
    upvotes: num(input.upvotes),
    replies: num(input.replies),
    traffic: num(input.traffic),
    note: typeof input.note === "string" && input.note.trim() ? input.note.slice(0, 500) : null,
    recordedBy: input.actor,
    recordedAt: new Date().toISOString(),
  };
}

/**
 * Record that the human posted a queued draft natively. Writes the outcome
 * onto the approval item and appends the hash-chained "community.posted"
 * event. Idempotent on re-record (latest write wins). Throws when the
 * approval isn't a community draft in this workspace.
 */
export async function recordCommunityOutcome(
  workspaceId: string,
  input: CommunityOutcomeInput,
): Promise<{ eventId: string; eventHash: string }> {
  if (!input.approvalId) throw new Error("recordCommunityOutcome: approvalId is required.");
  if (!input.actor) throw new Error("recordCommunityOutcome: actor is required.");
  return withWorkspaceScope(workspaceId, async (tx: TxClient) => {
    const approval = await tx.missionApproval.findFirst({
      where: { id: input.approvalId, workspaceId },
      select: { id: true, action: true, bindingJson: true },
    });
    if (!approval) throw new Error("Approval not found in this workspace.");
    if (approval.action !== COMMUNITY_DRAFT_ACTION) {
      throw new Error(
        `Approval ${approval.id} is not a community draft (action=${approval.action}).`,
      );
    }
    const outcome = sanitizeOutcome(input);
    const event = await appendApprovalEvent(tx, {
      approvalId: approval.id,
      workspaceId,
      actor: input.actor,
      action: COMMUNITY_POSTED_EVENT,
      detail: { ...outcome },
    });
    const binding = (approval.bindingJson ?? {}) as Record<string, unknown>;
    // StoredOutcome is JSON-safe by construction; sanitizeOutcome's
    // numbers/strings/nulls round-trip byte-identical. Cast through the
    // codebase's standard Prisma.Json cast (same as programmatic-service.ts).
    const outcomeJson = JSON.parse(JSON.stringify(outcome)) as unknown as Prisma.InputJsonValue;
    await tx.missionApproval.update({
      where: { id: approval.id },
      data: { bindingJson: { ...binding, outcome: outcomeJson } },
    });
    return { eventId: event.id, eventHash: event.eventHash };
  });
}

interface OutcomeRow {
  id: string;
  status: string;
  bindingJson: unknown;
  approvalEvents: Array<{ ts: Date; action: string; actor: string }>;
}

/**
 * All posted community outcomes for a workspace — the closed-loop feed.
 * Exported for M3's branded-mention tracking: community participation
 * drives the mentions that correlate 0.66–0.71 with AI-assistant visibility
 * (SPEC-PHASE10 §M3), so M3 can join these rows on threadUrl/approvalId.
 */
export async function getCommunityOutcomes(
  workspaceId: string,
): Promise<CommunityOutcome[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx: TxClient) =>
    tx.missionApproval.findMany({
      where: { workspaceId, action: COMMUNITY_DRAFT_ACTION },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: {
        id: true,
        status: true,
        bindingJson: true,
        approvalEvents: {
          where: { action: COMMUNITY_POSTED_EVENT },
          orderBy: { ts: "desc" },
          take: 1,
          select: { ts: true, action: true, actor: true },
        },
      },
    }),
  );
  const out: CommunityOutcome[] = [];
  for (const r of rows as unknown as OutcomeRow[]) {
    const b = (r.bindingJson ?? {}) as Record<string, unknown>;
    const o = (b.outcome ?? null) as StoredOutcome | null;
    if (!o) continue; // not posted yet — still in the draft queue
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    out.push({
      approvalId: r.id,
      source: (typeof b.source === "string" ? b.source : "hacker_news") as CommunitySourceId,
      threadTitle: str(b.thread),
      threadUrl: str(b.threadUrl),
      draftExcerpt: str(b.draft).slice(0, 160),
      approvalStatus: r.status,
      postedAt: typeof o.postedAt === "string" ? o.postedAt : null,
      upvotes: num(o.upvotes),
      replies: num(o.replies),
      traffic: num(o.traffic),
      note: typeof o.note === "string" ? o.note : null,
    });
  }
  return out;
}
