// ShapesOS — Phase 17 (A2/A3, WS=model): which tools are LOADED into the
// model's context up front, which are DEFERRED (found on demand), and the
// two loop-internal tools that go with that: search_tools (the client-side
// tool search, for providers without a server-side one) and fetch_more (the
// next slice of a capped tool result). PURE.
//
// Deferral never changes what an agent MAY do: the grant (lib/agents/
// grants.ts) and every gate in executeTool are unchanged. A deferred tool is
// still in the request (Anthropic: `defer_loading: true` + tool search, the
// API expands the reference when the model finds it) or, on the client-side
// path, offered as soon as search_tools surfaced it for the rest of the run.
//
// What stays loaded:
//   * the lead: LEAD_CORE_TOOLS (~16 — the workspace reads people ask about
//     every day, business-data answers, skills, web research, a draft, the
//     approval / workflow tools, delegation, fetch_more);
//   * a sub-agent: SUB_AGENT_CORE_READS plus every tool of the groups its
//     role exists for (ROLE_LOADED_GROUPS — the SUB_AGENTS briefs: the
//     Researcher reads the web, the Writer drafts, …);
//   * build mode (the Operator with the code group): the code + ship tools.
// Ops / finance / people / twin / apps reads and writes, connector tools and
// anything else is deferred. Small tool sets (≤ DEFER_MIN_TOOLS — a scheduled
// skill's declared tools) load everything: a search round-trip would cost
// more than it saves.

import type { ChatToolDef } from "@/lib/llm/types";
import type { AgentKey, ToolGroup } from "./grants";

/** Tool sets this small are sent whole (no deferral). */
export const DEFER_MIN_TOOLS = 20;

export const SEARCH_TOOLS_TOOL = "search_tools";
export const FETCH_MORE_TOOL = "fetch_more";

/** The lead's always-loaded tools (canonical names). */
export const LEAD_CORE_TOOLS: ReadonlySet<string> = new Set([
  "get_keywords",
  "get_rankings",
  "get_competitors",
  "get_content",
  "get_alerts",
  "get_visibility_score",
  "get_workflows",
  "ops_operations_summary",
  "ask_business_data",
  // Phase 18.1: Spotlight for agents (lib/search/tool.ts).
  "search_workspace",
  "load_skill",
  "research_question",
  "create_content_draft",
  "run_workflow",
  "approve_autopilot_item",
  "delegate_tasks",
  "delegate_to_subagent",
]);

/** Workspace reads every sub-agent keeps loaded (inventory of the SUB_AGENTS briefs). */
export const SUB_AGENT_CORE_READS: ReadonlySet<string> = new Set([
  "get_keywords",
  "get_rankings",
  "get_competitors",
  "get_content",
  "get_alerts",
  "ops_operations_summary",
  "ask_business_data",
  // Phase 18.1: every agent searches the same index people do.
  "search_workspace",
  "load_skill",
]);

/**
 * The groups each sub-agent's role is for (lib/aos/agents.ts SUB_AGENTS +
 * lib/agents/roles.ts briefs): their tools stay loaded when granted.
 */
export const ROLE_LOADED_GROUPS: Readonly<Record<Exclude<AgentKey, "lead">, readonly ToolGroup[]>> = {
  researcher: ["web", "data"], // "Finds and reads sources, then writes briefs with citations."
  planner: ["calendar"], // "Turns a goal into a dated plan of steps."
  drafter: ["content", "email"], // "Drafts emails, posts and docs in your voice."
  analyst: ["data", "code"], // "Reads the results and says what worked." (Code runner)
  scheduler: ["calendar", "automation"], // "Puts approved work on the calendar and runs it on time."
  actor: ["email", "calendar", "social", "site"], // "Acts in your connected apps."
};

/** Groups whose tools stay loaded in build mode (the test-fix loop needs them every step). */
const BUILD_MODE_GROUPS: readonly ToolGroup[] = ["code", "ship"];

export interface DeferralInput {
  agentKey: AgentKey;
  mode: "build" | "default";
  /** How many tools the run is offered in total (catalog + connectors). */
  toolCount: number;
}

/**
 * The deferral rule for one run: (canonical name, group) → deferred?
 * Returns null when nothing is deferred (small tool sets).
 */
export function deferralFor(input: DeferralInput): ((canonical: string, group: string) => boolean) | null {
  if (input.toolCount <= DEFER_MIN_TOOLS) return null;
  const loadedGroups = new Set<string>(input.agentKey === "lead" ? [] : ROLE_LOADED_GROUPS[input.agentKey]);
  if (input.mode === "build") for (const g of BUILD_MODE_GROUPS) loadedGroups.add(g);
  // Delegation tools are loaded wherever they are granted (the plan tools).
  loadedGroups.add("delegate");
  const core = input.agentKey === "lead" ? LEAD_CORE_TOOLS : SUB_AGENT_CORE_READS;
  return (canonical, group) => {
    if (core.has(canonical)) return false;
    if (loadedGroups.has(group)) return false;
    return true;
  };
}

// ── search_tools (client-side tool search) ───────────────────────────────────

export const SEARCH_TOOLS_DEF: ChatToolDef = {
  name: SEARCH_TOOLS_TOOL,
  description:
    "Find more tools by keyword when the task needs one you cannot see (operations: invoices, inventory, purchase orders, projects, HR, payroll, CRM, tickets, manufacturing, POS, events; the digital twin; mini-apps; connected apps; site, code and browser tools). Returns matching tools; they can be called from the next step on.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What the tool should do, in a few words (e.g. \"send an invoice\")." },
      limit: { type: "number", description: "Most tools to return (default 5, max 10)." },
    },
    required: ["query"],
  },
};

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 1);
}

/**
 * Rank deferred tools against a query (term overlap on name, description
 * and argument names — the fields Anthropic's own search covers). PURE and
 * deterministic: ties break by name.
 */
export function searchTools(defs: readonly ChatToolDef[], query: string, limit = 5): ChatToolDef[] {
  const q = [...new Set(words(query))];
  if (q.length === 0) return [];
  const scored: Array<{ def: ChatToolDef; score: number }> = [];
  for (const def of defs) {
    const name = words(def.name.replace(/__/g, " "));
    const desc = words(def.description);
    const args = words(Object.keys(def.inputSchema.properties ?? {}).join(" "));
    let score = 0;
    for (const t of q) {
      const stem = t.length > 4 ? t.slice(0, -1) : t; // invoices ~ invoice
      if (name.some((w) => w.startsWith(stem))) score += 3;
      if (desc.some((w) => w.startsWith(stem))) score += 1;
      if (args.some((w) => w.startsWith(stem))) score += 1;
    }
    if (score > 0) scored.push({ def, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.def.name < b.def.name ? -1 : 1));
  return scored.slice(0, Math.max(1, Math.min(10, Math.floor(limit) || 5))).map((s) => s.def);
}

// ── fetch_more (capped tool results) ─────────────────────────────────────────

export const FETCH_MORE_DEF: ChatToolDef = {
  name: FETCH_MORE_TOOL,
  description:
    "Read the next part of a tool result that was cut off. Pass the handle and offset the cut-off note gives you.",
  inputSchema: {
    type: "object",
    properties: {
      handle: { type: "string", description: "The handle from the cut-off note." },
      offset: { type: "number", description: "Character offset to read from (from the note)." },
    },
    required: ["handle"],
  },
};

/** Phase 17 (A3): characters of one tool result sent to the model (AGENT_TOOL_RESULT_MAX_CHARS overrides). */
export const DEFAULT_TOOL_RESULT_CAP = 8_000;
/** Most characters of one tool result kept for fetch_more (in the saved transcript). */
export const MAX_STORED_RESULT_CHARS = 200_000;
/** Most characters of all stored results in one run (oldest dropped first). */
export const MAX_STORED_TOTAL_CHARS = 1_000_000;

/** The cut-off note appended to a capped result (and the fetch_more contract). */
export function cutOffNote(handle: string, shown: number, total: number): string {
  return `\n…[cut off: ${total - shown} more characters. Call fetch_more with handle "${handle}" and offset ${shown} for the next part.]`;
}

/**
 * Cap one tool result. Returns the text the model sees and, when cut, the
 * full text to keep for fetch_more.
 */
export function capResult(handle: string, text: string, cap: number): { shown: string; stored: string | null } {
  if (text.length <= cap) return { shown: text, stored: null };
  return { shown: text.slice(0, cap) + cutOffNote(handle, cap, text.length), stored: text.slice(0, MAX_STORED_RESULT_CHARS) };
}

/** One fetch_more slice. */
export function sliceResult(stored: string | undefined, handle: string, offset: number, cap: number): { text: string; ok: boolean } {
  if (stored === undefined) return { ok: false, text: `No stored result for handle "${handle}" (it was not cut off, or it is from another run).` };
  const from = Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0));
  if (from >= stored.length) return { ok: true, text: `Nothing more: the result has ${stored.length} characters.` };
  const part = stored.slice(from, from + cap);
  const next = from + part.length;
  return { ok: true, text: next < stored.length ? part + cutOffNote(handle, next, stored.length) : part };
}

/** Keep the stored results within MAX_STORED_TOTAL_CHARS (drop the oldest). Mutates and returns the map. */
export function pruneStored(stored: Record<string, string>): Record<string, string> {
  let total = Object.values(stored).reduce((n, s) => n + s.length, 0);
  for (const key of Object.keys(stored)) {
    if (total <= MAX_STORED_TOTAL_CHARS) break;
    total -= stored[key].length;
    delete stored[key];
  }
  return stored;
}
