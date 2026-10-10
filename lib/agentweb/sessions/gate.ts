// ShapesOS — Phase 21A round 2 (WS=agentweb): the session gate in front of every browser tool.
//
// Order matters:
//   1. a session that is paused, under a person's control or over a cap refuses everything;
//   2. the tool's own page-aware gate (lib/agentweb/gate.ts via the tool's preflight) runs next:
//      if it refuses (a payment step, a password field) that refusal stands and nothing is
//      proposed to the person: they are never asked to approve what nobody may do;
//   3. only then, in review-each-step mode, is the step recorded as a proposal and refused for now.
// A step the person sends (ctx.humanStep) skips 1 and 3 but still goes through 2.
// Typed text of a proposed step is kept in this process's memory for the approval, never stored.

import type { ToolContext, ToolPreflight } from "@/lib/chat/tools";
import { taskKeyOf } from "../tasks";
import { evaluate, ensureSession, persistProposal, recordStep, setNeeds } from "./store";
import type { NeedsReason } from "./control";

type Ctx = ToolContext & { threadId?: string };

const refuse = (reason: string): ToolPreflight => ({ verdict: "refuse", reason });

const memory = new Map<string, { args: Record<string, unknown>; expires: number }>();
const TTL_MS = 30 * 60_000;

/** The full args of a proposal, once (they may hold typed text, so they never touch the database). */
export function takeProposalArgs(id: string): Record<string, unknown> | null {
  const m = memory.get(id);
  memory.delete(id);
  return m && m.expires > Date.now() ? m.args : null;
}

function remember(id: string, args: Record<string, unknown>) {
  const now = Date.now();
  for (const [k, v] of memory) if (v.expires <= now) memory.delete(k);
  memory.set(id, { args, expires: now + TTL_MS });
}

export async function sessionGate(rawCtx: ToolContext, tool: string, args: Record<string, unknown>, inner: () => Promise<ToolPreflight | undefined>): Promise<ToolPreflight> {
  const ctx = rawCtx as Ctx;
  const innerOrAllow = async () => (await inner()) ?? ({ verdict: "allow" } as ToolPreflight);
  if (!ctx.runId) return innerOrAllow();
  const ens = await ensureSession(ctx.workspaceId, { runId: ctx.runId, startedBy: ctx.userId, taskKey: taskKeyOf(ctx) }).catch(() => null);
  if (ens && !ens.ok && ens.reason === "limit") return refuse(ens.message);
  if (!ens || !ens.ok) return innerOrAllow(); // an unrecorded run cannot be supervised
  if (ctx.humanStep) return innerOrAllow();
  const g = await evaluate(ctx.workspaceId, ctx.runId, tool, args);
  if (!g.allow && g.reason !== "proposal") return refuse(g.message);
  const pre = await innerOrAllow();
  if (pre.verdict === "refuse") return pre;
  if (!g.allow && g.reason === "proposal") {
    if (g.propose) {
      const p = await persistProposal(ctx.workspaceId, ctx.runId, tool, args);
      remember(p.id, args);
    }
    return refuse(g.message);
  }
  return pre;
}

/** The session learns a step ran (count, where it is, what it touched). */
export async function sessionStep(ctx: ToolContext, step: { url?: string; origin?: string | null; channel?: string | null }): Promise<void> {
  if (!ctx.runId) return;
  await recordStep(ctx.workspaceId, ctx.runId, step).catch(() => undefined);
}

export async function sessionNeeds(ctx: ToolContext, reason: NeedsReason): Promise<void> {
  if (!ctx.runId) return;
  await setNeeds(ctx.workspaceId, ctx.runId, reason).catch(() => undefined);
}
