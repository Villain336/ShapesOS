// ShapesOS — Phase 11 (conncore): is the MCP server on for a workspace? PURE.
//
// Owner decision (Phase 11 plan): the MCP server is ON BY DEFAULT for paid
// plans that include API access (Pro, Agency) and stays OFF by default for
// everything else (trial, self-hosted, starter — starter isn't entitled at
// all). Workspace.mcpEnabled is the explicit admin choice:
//   null  → the plan default above;
//   true  → on (still needs the api_access entitlement — a downgrade closes
//           the surface immediately);
//   false → off — the explicit workspace off switch always wins.
// Every gate (lib/mcp/protocol.ts per request, lib/mcp/oauth.ts consent and
// token exchange, the keys route) reads this one function, fresh per call.
//
// Turning the default on does not open anything by itself: a caller still
// needs an MCP API key or an OAuth grant that an admin created.

import { planHasFeature } from "@/lib/billing/entitlements";

/** Paid plans whose workspaces get the MCP server on unless an admin turns it off. */
export const MCP_DEFAULT_ON_PLANS: readonly string[] = ["pro", "agency"];

export type McpEnabledSource = "explicit_on" | "explicit_off" | "plan_default";

export interface McpEffectiveState {
  /** The server answers for this workspace (entitled AND on). */
  enabled: boolean;
  /** The admin's switch, or the plan default when unset (entitlement aside). */
  on: boolean;
  /** The plan includes API/MCP access. */
  entitled: boolean;
  /** Where "on/off" comes from. */
  source: McpEnabledSource;
  /** What the plan default would be (for the settings UI). */
  planDefault: boolean;
}

export function mcpPlanDefault(plan: string | null | undefined): boolean {
  return !!plan && MCP_DEFAULT_ON_PLANS.includes(plan) && planHasFeature(plan, "api_access");
}

export function mcpEffectiveState(ws: { mcpEnabled: boolean | null | undefined; plan: string | null | undefined } | null): McpEffectiveState {
  const entitled = planHasFeature(ws?.plan, "api_access");
  const planDefault = mcpPlanDefault(ws?.plan);
  const explicit = ws?.mcpEnabled;
  const source: McpEnabledSource = explicit === true ? "explicit_on" : explicit === false ? "explicit_off" : "plan_default";
  const on = explicit === true || explicit === false ? explicit : planDefault;
  return { enabled: entitled && on, on, entitled, source, planDefault };
}
