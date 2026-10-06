// ShapesOS — Phase 18.2 (WS=content): the Store's catalogue (PURE).
//
// One list of everything a workspace can install, generated from each kind's
// EXISTING registry — never a copy:
//
//   mini_app          the workspace's own mini-apps (lib/apps; MiniApp rows)
//                     installed = published; tools = the spec's actions at
//                     their effective tier (lib/apps/spec.ts)
//   skill             the built-in skill packs (lib/skills/registry.ts
//                     REGISTRY_PACKS) + skills installed from a URL / upload;
//                     tools = the pack's declared tools
//   mission_template  lib/missions/templates.ts MISSION_TEMPLATES; tools = the
//                     plan's steps at their tier; a workspace can remove one
//                     from its picker (workspace_store_items)
//   mcp_server        the workspace's custom MCP servers (Connector kind=mcp);
//                     tools = its read-only list + admin tool policies
//   composio_toolkit  the Composio toolkit directory (lib/integrations/
//                     actions/toolkits.ts listDirectory); tools = its tier
//                     breakdown (low / medium / high / unclassified)
//   connector         the built-in connectors (lib/connectors/m21/registry.ts
//                     BUILT_IN_CONNECTORS); tools = the adapter's tools
//
// Tiers are the SAME ones the approval system uses at run time: a connector
// tool's action (lib/agents/grants.ts connectorAction / an MCP tool policy)
// or an agent tool's action (lib/chat/tools.ts toolAction) through
// evaluateTier (lib/orchestrator/authority.ts) — kind AND "<name>:
// <description>" scanned for Tier-3 words — plus "always asks" for
// destructive tools, NEVER_AUTO_ACTIONS and money connectors. Nothing here
// makes anything auto-approvable; it only shows what is.

import { evaluateTier, DEFAULT_SMALL_ACTION_THRESHOLD_CENTS, type DoATier } from "@/lib/orchestrator/authority";

export const STORE_KINDS = ["mini_app", "skill", "mission_template", "mcp_server", "composio_toolkit", "connector"] as const;
export type StoreKind = (typeof STORE_KINDS)[number];

/** Kinds an agency can publish to its client workspaces (they carry their content). */
export const PUBLISHABLE_KINDS: readonly StoreKind[] = ["mini_app", "skill", "mission_template"];

export interface StoreTool {
  name: string;
  description: string;
  /** The approval tier (0 runs on its own … 3 never automatic). */
  tier: DoATier;
  /** Never runs without a person's OK, whatever a rule says (Tier 3, destructive, never-auto). */
  alwaysAsks: boolean;
  /** A skill's declared tool this install doesn't have (yet): shown at Tier 2 — it would ask. */
  unresolved?: boolean;
}

/** A count of tools per tier when the tools themselves aren't listed (Composio). */
export interface TierCounts {
  tier0: number;
  tier2: number;
  tier3: number;
  unclassified: number;
}

export type PermissionKind =
  | "oauth"
  | "apiKey"
  | "platformKey"
  | "noCredential"
  | "composio"
  | "mcpEndpoint"
  | "records"
  | "budget"
  | "approvals"
  | "declaredTools"
  | "toolCalls";

export interface StorePermission {
  kind: PermissionKind;
  /** Registry data (scopes, an endpoint, entity names, …); never a secret. */
  detail: string;
}

export type InstallMode =
  /** Installed / removed right here, through the kind's own service. */
  | { mode: "inline"; minRole: "editor" | "admin"; permission?: "skills.install" }
  /** Needs credentials only its own page collects (connect flow). */
  | { mode: "link"; href: string };

export interface StoreItem {
  kind: StoreKind;
  /** Unique within the kind: pack key, template id, app slug, toolkit slug, connector key, MCP key. */
  key: string;
  name: string;
  description: string;
  category: string | null;
  version: string | null;
  tools: StoreTool[];
  tierCounts: TierCounts | null;
  permissions: StorePermission[];
  installed: boolean;
  /** A short state word for the badge: installed, published, enabled, connected, … */
  state: string;
  install: InstallMode;
  /** Can be removed again (a built-in template can be hidden, a registry skill uninstalled, …). */
  removable: boolean;
  /** builtin = from a registry; workspace = made in this workspace; agency = published by the agency. */
  source: "builtin" | "workspace" | "agency";
  /** The installed row's id where the kind has one (skill id, MCP connector id). */
  installedId: string | null;
}

const TIER_SETTINGS = { smallActionThresholdCents: DEFAULT_SMALL_ACTION_THRESHOLD_CENTS, automationAllows: true, defaultCurrency: "USD" } as const;

/** The tier an action has by nature (an automation rule could at most lower the ask for 0–2). */
export function actionTier(action: string, description: string): DoATier {
  return evaluateTier({ kind: action, description }, TIER_SETTINGS);
}

/** A connector / MCP tool's tier: reads are Tier 0; a write is its action's tier. */
export function connectorToolTier(
  tool: { name: string; description: string; mutating: boolean; destructive?: boolean },
  action: string | null,
  opts: { neverAuto?: ReadonlySet<string> | ReadonlyMap<string, string> } = {},
): StoreTool {
  if (!tool.mutating) return { name: tool.name, description: tool.description, tier: 0, alwaysAsks: false };
  // A write asks first by default (Phase 14: "ask" unless a rule says auto),
  // so it is never shown as Tier 0 even when its action's kind reads like a draft.
  const tier = Math.max(1, actionTier(action ?? "mcp_write", `${tool.name}: ${tool.description}`)) as DoATier;
  const neverAuto = !!action && !!opts.neverAuto?.has(action);
  return {
    name: tool.name,
    description: tool.description,
    tier,
    alwaysAsks: tool.destructive === true || tier === 3 || neverAuto,
  };
}

/** An agent tool's tier (lib/chat/tools.ts): safe = 0; otherwise its action's tier. */
export function agentToolTier(
  tool: { name: string; description: string; kind: "safe" | "destructive" | "publish" | "spend" },
  action: string,
  neverAuto?: ReadonlySet<string> | ReadonlyMap<string, string>,
): StoreTool {
  if (tool.kind === "safe") return { name: tool.name, description: tool.description, tier: 0, alwaysAsks: false };
  // Non-safe tools ask first unless a rule says auto (lib/agents/loop.ts): at least Tier 1.
  const tier = Math.max(1, actionTier(action, `${tool.name}: ${tool.description}`)) as DoATier;
  return {
    name: tool.name,
    description: tool.description,
    tier,
    alwaysAsks: tool.kind === "destructive" || tier === 3 || !!neverAuto?.has(action),
  };
}

/** Composio's risk tiers → approval tiers: low = reads (0), medium = writes (2), high = high-risk (3). */
export function composioTierCounts(b: { low: number; medium: number; high: number; unclassified: number }): TierCounts {
  return { tier0: b.low, tier2: b.medium, tier3: b.high, unclassified: b.unclassified };
}

/** The highest tier among an item's tools (null = no tools listed). */
export function maxTier(item: Pick<StoreItem, "tools" | "tierCounts">): DoATier | null {
  let max: DoATier | null = null;
  for (const t of item.tools) if (max === null || t.tier > max) max = t.tier;
  const c = item.tierCounts;
  if (c) {
    if (c.tier3 > 0 || c.unclassified > 0) return 3;
    if (c.tier2 > 0 && (max === null || max < 2)) max = 2;
    if (c.tier0 > 0 && max === null) max = 0;
  }
  return max;
}

/** Sort: installed first within a kind, then by name. */
export function sortCatalogue(items: StoreItem[]): StoreItem[] {
  const kindOrder = (k: StoreKind) => STORE_KINDS.indexOf(k);
  return [...items].sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name));
}

/** Filter by kind and a search query over name, description, category and tool names. */
export function filterCatalogue(items: StoreItem[], opts: { kind?: StoreKind | "all"; q?: string; installedOnly?: boolean }): StoreItem[] {
  const q = (opts.q ?? "").trim().toLowerCase();
  return items.filter((i) => {
    if (opts.kind && opts.kind !== "all" && i.kind !== opts.kind) return false;
    if (opts.installedOnly && !i.installed) return false;
    if (!q) return true;
    const hay = `${i.name} ${i.description} ${i.category ?? ""} ${i.tools.map((t) => t.name).join(" ")}`.toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  });
}

// ---------------------------------------------------------------------------
// Builders: one per registry. Each takes the registry's own data plus the
// workspace's state and returns StoreItems. No I/O.
// ---------------------------------------------------------------------------

export interface SkillPackInput {
  key: string;
  name: string;
  description: string;
  version: string;
  declaredTools: string[];
}

export interface InstalledSkillInput {
  id: string;
  name: string;
  description: string;
  version: string;
  source: "registry" | "url" | "upload";
  sourceRef: string | null;
  declaredTools: string[];
}

/**
 * Skills: every registry pack (installed or not) plus every skill installed
 * from a URL / upload / an agency (those exist only in this workspace).
 * `resolveTool` gives a declared tool's tier (connector or agent tool), or
 * null when it isn't a tool this install knows (it is then listed as
 * "checked when it runs" — Tier 2, asks — fail closed).
 */
export function skillItems(
  packs: SkillPackInput[],
  installed: InstalledSkillInput[],
  resolveTool: (declared: string) => StoreTool | null,
  agencySkillIds: ReadonlySet<string> = new Set(),
): StoreItem[] {
  const tools = (declared: string[]) =>
    declared.map((d) => resolveTool(d) ?? { name: d, description: "", tier: 2 as DoATier, alwaysAsks: false, unresolved: true });
  const out: StoreItem[] = [];
  for (const p of packs) {
    const row = installed.find((s) => s.source === "registry" && s.sourceRef === p.key);
    out.push({
      kind: "skill",
      key: p.key,
      name: p.name,
      description: p.description,
      category: null,
      version: row?.version ?? p.version,
      tools: tools(p.declaredTools),
      tierCounts: null,
      permissions: p.declaredTools.length ? [{ kind: "declaredTools", detail: p.declaredTools.join(", ") }] : [],
      installed: !!row,
      state: row ? "installed" : "available",
      install: { mode: "inline", minRole: "admin", permission: "skills.install" },
      removable: true,
      source: "builtin",
      installedId: row?.id ?? null,
    });
  }
  for (const s of installed) {
    if (s.source === "registry" && packs.some((p) => p.key === s.sourceRef)) continue;
    out.push({
      kind: "skill",
      key: `installed:${s.id}`,
      name: s.name,
      description: s.description,
      category: null,
      version: s.version,
      tools: tools(s.declaredTools),
      tierCounts: null,
      permissions: s.declaredTools.length ? [{ kind: "declaredTools", detail: s.declaredTools.join(", ") }] : [],
      installed: true,
      state: "installed",
      install: { mode: "inline", minRole: "admin", permission: "skills.install" },
      removable: true,
      source: agencySkillIds.has(s.id) ? "agency" : "workspace",
      installedId: s.id,
    });
  }
  return out;
}

export interface TemplateInput {
  id: string;
  name: string;
  description: string;
  businessTypeLabel: string;
  plan: Array<{ key: string; title: string; description: string; tier: 0 | 1 | 2 }>;
  budgetDefaults: { maxCostCents: number; maxSteps: number };
}

/** Mission templates: listed unless the workspace removed one (then "available" again). */
export function templateItems(templates: TemplateInput[], removed: ReadonlySet<string>, agencyInstalled: ReadonlySet<string> = new Set()): StoreItem[] {
  return templates.map((t) => {
    const approvals = t.plan.filter((s) => s.tier === 2).length;
    return {
      kind: "mission_template" as const,
      key: t.id,
      name: t.name,
      description: t.description,
      category: t.businessTypeLabel,
      version: null,
      tools: t.plan.map((s) => ({ name: s.title, description: s.description, tier: s.tier as DoATier, alwaysAsks: false })),
      tierCounts: null,
      permissions: [
        { kind: "budget" as const, detail: `$${(t.budgetDefaults.maxCostCents / 100).toFixed(0)} · ${t.budgetDefaults.maxSteps}` },
        ...(approvals ? [{ kind: "approvals" as const, detail: String(approvals) }] : []),
      ],
      installed: !removed.has(t.id),
      state: removed.has(t.id) ? "available" : "installed",
      install: { mode: "inline" as const, minRole: "admin" as const },
      removable: true,
      source: agencyInstalled.has(t.id) ? ("agency" as const) : ("builtin" as const),
      installedId: null,
    };
  });
}

export interface MiniAppInput {
  slug: string;
  name: string;
  description: string | null;
  version: number;
  published: boolean;
  entities: string[];
  actions: Array<{ key: string; label: string; description?: string; tier: 0 | 1 | 2 }>;
}

/** The workspace's mini-apps: installed = published (unpublish keeps the records). */
export function miniAppItems(apps: MiniAppInput[], agencySlugs: ReadonlySet<string> = new Set()): StoreItem[] {
  return apps.map((a) => ({
    kind: "mini_app" as const,
    key: a.slug,
    name: a.name,
    description: a.description ?? "",
    category: null,
    version: a.version > 0 ? `v${a.version}` : null,
    tools: a.actions.map((x) => ({ name: x.label, description: x.description ?? "", tier: x.tier as DoATier, alwaysAsks: false })),
    tierCounts: null,
    permissions: [{ kind: "records" as const, detail: a.entities.join(", ") }],
    installed: a.published,
    state: a.published ? "published" : "draft",
    install: { mode: "inline" as const, minRole: "admin" as const },
    removable: true,
    source: agencySlugs.has(a.slug) ? ("agency" as const) : ("workspace" as const),
    installedId: null,
  }));
}

export interface ToolkitInput {
  toolkitSlug: string;
  label: string;
  description: string;
  category: string;
  connected: boolean;
  enabled: boolean;
  toolCount: number;
  tierBreakdown: { low: number; medium: number; high: number; unclassified: number };
}

/** Composio toolkits: installed = enabled for the workspace (connecting is its own step). */
export function toolkitItems(directory: ToolkitInput[]): StoreItem[] {
  return directory.map((t) => ({
    kind: "composio_toolkit" as const,
    key: t.toolkitSlug,
    name: t.label,
    description: t.description,
    category: t.category,
    version: null,
    tools: [],
    tierCounts: composioTierCounts(t.tierBreakdown),
    permissions: [{ kind: "composio" as const, detail: t.connected ? "connected" : "not connected" }],
    installed: t.enabled,
    state: t.enabled ? (t.connected ? "connected" : "enabled") : "available",
    install: { mode: "inline" as const, minRole: "editor" as const },
    removable: true,
    source: "builtin" as const,
    installedId: null,
  }));
}

export interface ConnectorInput {
  key: string;
  displayName: string;
  description: string;
  authType: "oauth2" | "api_key" | "none";
  scopes: string[];
  platformKeyEnv: string | null;
  tools: StoreTool[];
  connections: number;
}

/** Built-in connectors: installed = connected in this workspace. Connecting needs credentials: its own page. */
export function connectorItems(connectors: ConnectorInput[]): StoreItem[] {
  return connectors.map((c) => {
    const permissions: StorePermission[] = [];
    if (c.platformKeyEnv) permissions.push({ kind: "platformKey", detail: c.platformKeyEnv });
    else if (c.authType === "oauth2") permissions.push({ kind: "oauth", detail: c.scopes.join(" ") || "—" });
    else if (c.authType === "api_key") permissions.push({ kind: "apiKey", detail: "" });
    else permissions.push({ kind: "noCredential", detail: "" });
    return {
      kind: "connector" as const,
      key: c.key,
      name: c.displayName,
      description: c.description,
      category: null,
      version: null,
      tools: c.tools,
      tierCounts: null,
      permissions,
      installed: c.connections > 0 || !!c.platformKeyEnv,
      state: c.platformKeyEnv ? "platform" : c.connections > 0 ? "connected" : "available",
      install: { mode: "link" as const, href: `/dashboard/settings/connectors?connector=${encodeURIComponent(c.key)}` },
      removable: !c.platformKeyEnv,
      source: "builtin" as const,
      installedId: null,
    };
  });
}

export interface McpServerInput {
  id: string;
  key: string;
  displayName: string;
  endpoint: string | null;
  tools: StoreTool[];
  connections: number;
}

/** The workspace's custom MCP servers (added and removed in Settings → Connectors). */
export function mcpItems(servers: McpServerInput[]): StoreItem[] {
  return servers.map((s) => ({
    kind: "mcp_server" as const,
    key: s.key,
    name: s.displayName,
    description: s.endpoint ?? "",
    category: null,
    version: null,
    tools: s.tools,
    tierCounts: null,
    permissions: [{ kind: "mcpEndpoint" as const, detail: s.endpoint ?? "stdio" }, { kind: "toolCalls" as const, detail: "mcp_write" }],
    installed: true,
    state: s.connections > 0 ? "connected" : "added",
    install: { mode: "link" as const, href: `/dashboard/settings/connectors?connector=${encodeURIComponent(s.key)}` },
    removable: true,
    source: "workspace" as const,
    installedId: s.id,
  }));
}
