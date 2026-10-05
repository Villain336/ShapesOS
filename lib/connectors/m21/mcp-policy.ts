// ShapesOS — Phase 11 (conncore): map each custom MCP tool to a Phase 5
// tool group and an automation action (its approval tier). PURE — safe to
// import in the browser.
//
// Stored on Connector.config.toolPolicies = { [toolName]: { group, action } }
// by an admin on Settings → Connectors (PATCH /api/connectors/mcp/[id]).
//
//   group  — which task grant covers the tool (lib/agents/grants.ts). A tool
//            with no mapping is in "connectors" (Connected apps), like before.
//   action — the automation action the tool stands for when it writes, so
//            per-agent auto-approve rules (lib/automation/policy.ts) and the
//            tier evaluator decide whether it may run without asking. No
//            mapping → "mcp_write" (Phase 14; was "connector_write"): Tier 2,
//            asks unless a rule switches mcp_write to Auto-run. Tool
//            descriptions are still scanned for Tier-3 wording, and a tool
//            the server marks destructiveHint=true never runs without asking.
//            Read-only tools (server readOnlyHint or the admin allow-list)
//            never ask.

import { TOOL_GROUPS, type ToolGroup } from "@/lib/agents/grants";
import { KNOWN_ACTION_DEFS } from "@/lib/automation/actions";

export const DEFAULT_MCP_GROUP: ToolGroup = "connectors";
export const DEFAULT_MCP_ACTION = "mcp_write";

/** Groups an admin may put an MCP tool in (never the always-on / hand-off groups). */
export const MCP_ASSIGNABLE_GROUPS: readonly ToolGroup[] = TOOL_GROUPS.filter((g) => g !== "workspace" && g !== "delegate");

/** Actions an admin may map an MCP tool to (the catalog + the unknown-write default). */
export const MCP_ASSIGNABLE_ACTIONS: readonly string[] = [...new Set([DEFAULT_MCP_ACTION, ...KNOWN_ACTION_DEFS.map((d) => d.action)])];

export interface McpToolPolicy {
  group: ToolGroup;
  action: string;
}

const NAME_RE = /^[A-Za-z0-9_.\-]{1,200}$/;

/** The stored policies, keeping only well-formed entries (fail closed). */
export function mcpToolPolicies(config: unknown): Record<string, McpToolPolicy> {
  if (!config || typeof config !== "object" || Array.isArray(config)) return {};
  const raw = (config as Record<string, unknown>).toolPolicies;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, McpToolPolicy> = {};
  for (const [name, p] of Object.entries(raw as Record<string, unknown>)) {
    if (!NAME_RE.test(name) || !p || typeof p !== "object") continue;
    const group = (p as { group?: unknown }).group;
    const action = (p as { action?: unknown }).action;
    out[name] = {
      group: (MCP_ASSIGNABLE_GROUPS as readonly unknown[]).includes(group) ? (group as ToolGroup) : DEFAULT_MCP_GROUP,
      action: typeof action === "string" && MCP_ASSIGNABLE_ACTIONS.includes(action) ? action : DEFAULT_MCP_ACTION,
    };
  }
  return out;
}

export function mcpToolGroup(config: unknown, tool: string): ToolGroup {
  return mcpToolPolicies(config)[tool]?.group ?? DEFAULT_MCP_GROUP;
}

export function mcpToolAction(config: unknown, tool: string): string {
  return mcpToolPolicies(config)[tool]?.action ?? DEFAULT_MCP_ACTION;
}

/** Validate an admin's PATCH body; returns the cleaned map or an error. */
export function validateToolPolicies(input: unknown): { ok: true; policies: Record<string, McpToolPolicy> } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "toolPolicies must be an object" };
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 500) return { ok: false, error: "at most 500 tool policies" };
  const out: Record<string, McpToolPolicy> = {};
  for (const [name, p] of entries) {
    if (!NAME_RE.test(name)) return { ok: false, error: `invalid tool name "${name.slice(0, 60)}"` };
    const group = (p as { group?: unknown })?.group;
    const action = (p as { action?: unknown })?.action;
    if (!(MCP_ASSIGNABLE_GROUPS as readonly unknown[]).includes(group)) return { ok: false, error: `${name}: unknown group` };
    if (typeof action !== "string" || !MCP_ASSIGNABLE_ACTIONS.includes(action)) return { ok: false, error: `${name}: unknown action` };
    out[name] = { group: group as ToolGroup, action };
  }
  return { ok: true, policies: out };
}
