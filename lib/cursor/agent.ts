// ShapesOS — Phase 19A (WS=server): the cursor's agent mode — "ShapesOS,
// research our competitors in the background, max $3".
//
// POST /api/cursor/agent { goal, maxUsd, conversationId? } (or a turn with
// mode "agent") starts the lead agent on the goal as a background run:
//   - an AgentRun of kind "cursor" with budgetMicroUsd = maxUsd — the loop
//     stops before a model call that would cross it, and the Phase 16
//     delegation split gives sub-agents at most what is left of it;
//   - handed to the agent worker at once (a chat_turn job on its own
//     thread), so progress streams on GET /api/agent-runs/[runId]/watch and
//     shows in the tray (GET /api/agents/activity) and the sidebar tree;
//   - every action still goes through executeTool (Tier 3 / destructive
//     always ask; auto rules apply). It is charged like any agent run.
// maxUsd is validated server-side: > 0 and ≤ the plan's ceiling
// (lib/billing/entitlements.ts CURSOR_AGENT_MAX_USD_CEILING).

import type { WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { roleAtLeast } from "@/lib/authz";
import { cursorAgentMaxUsdCeiling } from "@/lib/billing/entitlements";
import { appendAgentRunEvent } from "@/lib/agents/runs/service";
import { authorityAudit } from "@/lib/authority/db";

export class CursorAgentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CursorAgentError";
  }
}

export const MAX_GOAL_CHARS = 2_000;

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};

/**
 * The spending limit spoken in a request ("max $3", "maximum 2.50 dollars",
 * "up to five dollars"), in USD; null when none was said. PURE.
 */
export function spokenMaxUsd(text: string): number | null {
  const t = text.toLowerCase();
  const m =
    /\b(?:max(?:imum)?|up to|no more than|at most|limit(?: of)?|budget(?: of)?|cap(?: of| at)?)\s*(?:of\s*)?\$\s*(\d+(?:\.\d{1,2})?)/.exec(t) ??
    /\b(?:max(?:imum)?|up to|no more than|at most|limit(?: of)?|budget(?: of)?|cap(?: of| at)?)\s*(\d+(?:\.\d{1,2})?)\s*(?:dollars?|usd|bucks)\b/.exec(t) ??
    /\b(?:max(?:imum)?|up to|no more than|at most|limit(?: of)?|budget(?: of)?|cap(?: of| at)?)\s*([a-z]+)\s*(?:dollars?|bucks)\b/.exec(t);
  if (!m) return null;
  const raw = m[1]!;
  const n = /^\d/.test(raw) ? Number(raw) : (WORD_NUMBERS[raw] ?? NaN);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Validate maxUsd against the plan's ceiling. PURE. */
export function validateMaxUsd(maxUsd: unknown, plan: string | null | undefined): { ok: true; microUsd: number; maxUsd: number } | { ok: false; message: string } {
  const n = typeof maxUsd === "number" ? maxUsd : Number.NaN;
  const ceiling = cursorAgentMaxUsdCeiling(plan);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, message: "Give a spending limit above $0, for example max $3." };
  if (n > ceiling) return { ok: false, message: `The most one background task can spend on this plan is $${ceiling}.` };
  return { ok: true, microUsd: Math.round(n * 1_000_000), maxUsd: Math.round(n * 100) / 100 };
}

export interface StartAgentInput {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  goal: string;
  maxUsd: number;
  conversationId?: string | null;
}

export async function startCursorAgent(input: StartAgentInput): Promise<{ runId: string; maxUsd: number }> {
  if (!roleAtLeast(input.role, "editor")) throw new CursorAgentError(403, "forbidden", "Viewers can't start background tasks.");
  const goal = input.goal.trim().slice(0, MAX_GOAL_CHARS);
  if (!goal) throw new CursorAgentError(400, "bad_request", "Say what the task is.");
  const ws = await prisma.workspace.findUnique({ where: { id: input.workspaceId }, select: { plan: true } });
  const v = validateMaxUsd(input.maxUsd, ws?.plan);
  if (!v.ok) throw new CursorAgentError(400, "invalid_max_usd", v.message);
  const project = await prisma.project.findFirst({ where: { workspaceId: input.workspaceId }, orderBy: { updatedAt: "desc" }, select: { id: true } });
  if (!project) throw new CursorAgentError(409, "no_project", "Create a project first: background tasks run inside one.");

  // Its own thread (the worker continues the run from it; the chat shows it).
  const thread = await prisma.aiChatThread.create({
    data: { projectId: project.id, userId: input.userId, title: `Cursor: ${goal.slice(0, 40)}`, agentKey: "lead" },
    select: { id: true },
  });
  await prisma.aiChatMessage.create({ data: { threadId: thread.id, role: "user", content: goal } });

  const { runTrackedAgentTurn } = await import("@/lib/chat/agent");
  const out = await runTrackedAgentTurn(
    { projectId: project.id, workspaceId: input.workspaceId, userId: input.userId, role: input.role, threadId: thread.id, userContent: goal },
    {
      // Straight to the agent worker: this is background work.
      inlineBudgetMs: 0,
      runKind: "cursor",
      budgetMicroUsd: v.microUsd,
      agentState: { surface: "desktop", mode: "agent", maxUsd: v.maxUsd, ...(input.conversationId ? { conversationId: input.conversationId } : {}) },
    },
  );
  await appendAgentRunEvent(input.workspaceId, out.runId, {
    type: "note",
    summary: `Started from the cursor with a spend cap of $${v.maxUsd.toFixed(2)}`,
    payload: { kind: "cursor_agent", maxUsd: v.maxUsd, budgetMicroUsd: v.microUsd, conversationId: input.conversationId ?? null },
  }).catch(() => undefined);
  await authorityAudit
    .logAsync({ workspaceId: input.workspaceId, actor: input.userId, action: "cursor.agent_started", entityType: "cursor_run", entityId: out.runId, detail: { goal: goal.slice(0, 300), maxUsd: v.maxUsd, conversationId: input.conversationId ?? null } })
    .catch(() => undefined);
  return { runId: out.runId, maxUsd: v.maxUsd };
}
