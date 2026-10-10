// ShapesOS — Phase 21A (WS=agentweb): the call gate executeTool consults.
//
// Two checks run before the confirmation gate, in this order:
//   1. the tool's own preflight (browser steps judged against the live page);
//   2. taint tracking for every other tool that does something: page text the
//      task has read (a web page, a search result, a snippet) may not flow into
//      a send, post, write or request without a person confirming a card that
//      names the value and where it came from. A secret never flows.
//
// Pure with respect to the database; the only state is the task registry.

import type { ToolContext, ToolDef, ToolPreflight } from "@/lib/chat/tools";
import { checkFlow } from "./taint";
import { taskKeyOf, webTasks } from "./tasks";

const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}...` : s);

/** Taint check of a tool call's arguments against what this task has read. */
export function taintPreflight(ctx: ToolContext & { threadId?: string }, tool: Pick<ToolDef, "name" | "kind">, args: Record<string, unknown>): ToolPreflight {
  if (tool.kind === "safe") return { verdict: "allow" };
  const task = webTasks.get(taskKeyOf(ctx));
  if (!task) return { verdict: "allow" };
  const flow = checkFlow(task.kernel.ledger, { name: tool.name, kind: "send" }, args);
  if (flow.verdict === "refuse") return { verdict: "refuse", reason: `${tool.name} would carry a secret out of ShapesOS, so it was stopped.` };
  if (flow.verdict === "confirm") {
    const h = flow.hits[0]!;
    return { verdict: "confirm", reason: `${tool.name} would use text taken from ${h.origin} ("${short(h.value)}") in "${h.arg}". Check it is what you want.` };
  }
  return { verdict: "allow" };
}

export async function preflightFor(ctx: ToolContext, tool: ToolDef, args: Record<string, unknown>): Promise<ToolPreflight> {
  if (tool.preflight) {
    try {
      return await tool.preflight(ctx, args);
    } catch (err) {
      // A gate that cannot decide does not let the call through.
      return { verdict: "refuse", reason: `${tool.name} could not be checked (${err instanceof Error ? err.message : "error"}), so it was stopped.` };
    }
  }
  return taintPreflight(ctx, tool, args);
}
