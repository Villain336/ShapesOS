// ShapesOS — Phase 18.2 (WS=content): the Store's agent tool (listed in
// lib/chat/tools.ts TOOLS).
//
//   list_store_items  safe · Tier 0 · group "workspace" · viewer
//
// Read-only: what can be installed in this workspace (mini-apps, skills,
// mission templates, MCP servers, Composio toolkits, built-in connectors),
// what is installed, and each item's tools with their approval tiers. An
// agent can't install anything: installing changes what agents may do, so it
// is a person's decision in the Store (permissions shown and confirmed).
// The description avoids every Tier-3 word (lib/orchestrator/authority.ts).

import type { ToolDef, ToolResult } from "@/lib/chat/tools";
import { filterCatalogue, maxTier, STORE_KINDS, type StoreKind } from "./catalogue";

export const list_store_items: ToolDef = {
  name: "list_store_items",
  description:
    "List what can be installed in this workspace from the Store — mini-apps, skills, mission templates, MCP servers, Composio toolkits and built-in connectors — with whether each is installed and the approval tier of the tools it brings. Read-only; installing is done by a person in the Store.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: {
      kind: { type: "string", description: `One of ${STORE_KINDS.join(", ")} (default: all).` },
      query: { type: "string", description: "Words to look for in names, descriptions and tool names." },
      installed_only: { type: "boolean", description: "Only what is installed (default false)." },
    },
  },
  async execute(ctx, args): Promise<ToolResult> {
    const kind = typeof args.kind === "string" && (STORE_KINDS as readonly string[]).includes(args.kind) ? (args.kind as StoreKind) : "all";
    try {
      // Lazy: the catalogue reads every registry (and the chat tool registry itself).
      const { loadStoreCatalogue } = await import("./service");
      const cat = await loadStoreCatalogue({ workspaceId: ctx.workspaceId, userId: ctx.userId, role: ctx.role });
      const items = filterCatalogue(cat.items, { kind, q: typeof args.query === "string" ? args.query : "", installedOnly: args.installed_only === true }).slice(0, 60);
      const lines = items.map((i) => {
        const top = maxTier(i);
        const tools = i.tools.length ? `${i.tools.length} tool${i.tools.length === 1 ? "" : "s"}` : i.tierCounts ? `${i.tierCounts.tier0 + i.tierCounts.tier2 + i.tierCounts.tier3 + i.tierCounts.unclassified} tools` : "no tools";
        return `- [${i.kind}] ${i.name} (${i.key}) — ${i.installed ? i.state : "not installed"}; ${tools}${top !== null ? `, up to Tier ${top}` : ""}`;
      });
      const head = items.length ? `${items.length} item${items.length === 1 ? "" : "s"}:` : "Nothing in the Store matches.";
      const missing = cat.unavailable.map((u) => `(${u.kind} unavailable right now: ${u.reason})`);
      return {
        summary: [head, ...lines, ...missing].join("\n"),
        details: { items: items.map((i) => ({ kind: i.kind, key: i.key, name: i.name, installed: i.installed, state: i.state, tools: i.tools, tierCounts: i.tierCounts })) },
      };
    } catch (err) {
      return { summary: `Can't read the Store: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

export const STORE_TOOLS: readonly ToolDef[] = [list_store_items];
