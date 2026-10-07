// ShapesOS — Phase 19A (WS=server): deciding a cursor proposal
// (POST /api/cursor/approve { approvalId, decision, via }).
//
// Server-side rules — the client is never trusted:
//   - only the person the proposal was made for decides it, as an editor+
//     of the workspace (a viewer is refused before anything is read);
//   - a pending, unexpired proposal only (each is decided once: the row is
//     claimed pending → approved atomically before anything runs);
//   - a SPOKEN approval of a Tier 3 or destructive action is refused with
//     403 voice_not_allowed. The tier is recomputed from the tool registry
//     at decision time and the stricter of that and the stored value wins;
//   - an approval runs through executeTool with confirmed = true — the same
//     gate chat uses (grant, role, Stop); its result is recorded on the
//     run's timeline and in the hash-chained audit.

import type { WorkspaceRole } from "@prisma/client";
import { roleAtLeast } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { getTool, toolAction } from "@/lib/chat/tools";
import { executeTool, type ChatToolCall } from "@/lib/chat/tool-exec";
import { appendAgentRunEvent } from "@/lib/agents/runs/service";
import { authorityAudit } from "@/lib/authority/db";
import { cursorActionPolicy, voiceDecisionAllowed } from "./policy";
import { cursorGrant } from "./brain";

export class CursorDecisionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CursorDecisionError";
  }
}

export interface DecideInput {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  approvalId: string;
  decision: "approve" | "reject";
  via: "voice" | "click";
}

export interface DecideResult {
  approvalId: string;
  status: "executed" | "failed" | "rejected" | "pending_confirmation";
  resultSummary: string;
}

async function audit(workspaceId: string, actor: string, action: string, runId: string, detail: Record<string, unknown>) {
  await authorityAudit.logAsync({ workspaceId, actor, action, entityType: "cursor_run", entityId: runId, detail }).catch(() => undefined);
}

export async function decideCursorProposal(input: DecideInput, now: Date = new Date()): Promise<DecideResult> {
  if (!roleAtLeast(input.role, "editor")) throw new CursorDecisionError(403, "forbidden", "Viewers can't approve actions.");
  const row = await withWorkspaceScope(input.workspaceId, (tx) =>
    tx.cursorProposal.findFirst({ where: { id: input.approvalId, workspaceId: input.workspaceId } }),
  );
  if (!row || row.userId !== input.userId) throw new CursorDecisionError(404, "not_found", "That proposal was not found.");
  if (row.status !== "pending") throw new CursorDecisionError(409, "already_decided", `That proposal was already ${row.status}.`);
  if (row.expiresAt.getTime() <= now.getTime()) {
    await withWorkspaceScope(input.workspaceId, (tx) => tx.cursorProposal.updateMany({ where: { id: row.id, workspaceId: input.workspaceId, status: "pending" }, data: { status: "expired" } }));
    throw new CursorDecisionError(410, "expired", "That proposal expired. Ask again.");
  }

  const def = getTool(row.tool);
  const fresh = cursorActionPolicy({ tool: row.tool, description: def?.description ?? row.tool, kind: def?.kind ?? "publish", action: toolAction(row.tool) });
  const voiceApprovable = row.voiceApprovable && fresh.voiceApprovable;
  if (!voiceDecisionAllowed({ voiceApprovable }, input.via, input.decision)) {
    await appendAgentRunEvent(input.workspaceId, row.runId, {
      type: "gate",
      summary: `Spoken approval refused for ${row.tool}: click the card to approve`.slice(0, 500),
      payload: { kind: "cursor_voice_refused", approvalId: row.id, tool: row.tool, tier: Math.max(row.tier, fresh.tier), destructive: row.destructive || fresh.destructive },
    }).catch(() => undefined);
    await audit(input.workspaceId, input.userId, "cursor.voice_refused", row.runId, { approvalId: row.id, tool: row.tool, tier: Math.max(row.tier, fresh.tier) });
    throw new CursorDecisionError(403, "voice_not_allowed", fresh.reason ?? "This action needs a click on the card, not a spoken yes.");
  }

  // Claim it exactly once.
  const claimed = await withWorkspaceScope(input.workspaceId, (tx) =>
    tx.cursorProposal.updateMany({
      where: { id: row.id, workspaceId: input.workspaceId, status: "pending" },
      data: { status: input.decision === "approve" ? "approved" : "rejected", decidedVia: input.via, decidedBy: input.userId, decidedAt: now },
    }),
  );
  if (claimed.count !== 1) throw new CursorDecisionError(409, "already_decided", "That proposal was already decided.");

  if (input.decision === "reject") {
    await appendAgentRunEvent(input.workspaceId, row.runId, {
      type: "gate",
      summary: `Declined ${row.tool} (${input.via})`.slice(0, 500),
      payload: { kind: "cursor_decision", approvalId: row.id, decision: "reject", via: input.via },
    }).catch(() => undefined);
    await audit(input.workspaceId, input.userId, "cursor.reject", row.runId, { approvalId: row.id, tool: row.tool, via: input.via });
    return { approvalId: row.id, status: "rejected", resultSummary: "Declined." };
  }

  const call: ChatToolCall = { tool: row.tool, args: (row.args ?? {}) as Record<string, unknown>, status: "error", runId: row.runId, confirmed: true };
  const result = await executeTool(
    {
      projectId: row.projectId ?? "",
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      confirmed: true,
      agentKey: "lead",
      grant: cursorGrant(),
      runId: row.runId,
    },
    row.tool,
    call.args,
    call,
  );
  const status: DecideResult["status"] = call.status === "executed" ? "executed" : call.status === "pending_confirmation" ? "pending_confirmation" : "failed";
  const summary = (result?.summary ?? call.resultSummary ?? status).slice(0, 1000);
  await withWorkspaceScope(input.workspaceId, (tx) =>
    tx.cursorProposal.updateMany({ where: { id: row.id, workspaceId: input.workspaceId }, data: { status: status === "executed" ? "executed" : "failed", resultSummary: summary } }),
  );
  await appendAgentRunEvent(input.workspaceId, row.runId, {
    type: "gate",
    summary: `Approved ${row.tool} (${input.via}): ${summary}`.slice(0, 500),
    payload: { kind: "cursor_decision", approvalId: row.id, decision: "approve", via: input.via, status },
  }).catch(() => undefined);
  await audit(input.workspaceId, input.userId, "cursor.approve", row.runId, { approvalId: row.id, tool: row.tool, via: input.via, status, summary: summary.slice(0, 300) });
  return { approvalId: row.id, status, resultSummary: summary };
}
