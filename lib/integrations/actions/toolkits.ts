// Marketr — Phase 15 slice 3: toolkit directory + WorkspaceToolkit enablement
// (spec §§3/7; locked: FULL FIREHOSE, NO PACKS).
//
// The directory lists every toolkit the tool router knows (8 fixture
// toolkits without a key; Composio's live directory when COMPOSIO_API_KEY
// is set — Phase 6), with per-workspace
// connection state, enablement state, tool counts and tier breakdowns.
//
// Enablement semantics (the gate enforces this in gate.ts proposeAction):
//   - explicit WorkspaceToolkit row → its enabled flag wins;
//   - no row + toolkit in the v1 five (gmail, google_sheets, slack, hubspot,
//     notion) → enabled (backward compat: existing workspaces see zero
//     regression without any row);
//   - no row + any other toolkit → disabled (full firehose is opt-in).
//
// setToolkitEnabled() records the explicit workspace decision. There are no
// packs: curated bundles were rejected at spec lock, so every toolkit is
// enabled/disabled à la carte.

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { getToolRouter } from "@/lib/integrations/actions/discovery";
import { deriveTier } from "@/lib/integrations/actions/derive";
import { V1_ACTION_CATALOG, V1_COMPOSIO_APPS } from "@/lib/integrations/actions/risk";
import { listConnections } from "@/lib/integrations/actions/connections";
import { BadRequestError } from "@/lib/api/errors";

export type ToolkitCategory =
  | "comms"
  | "crm"
  | "files"
  | "payments"
  | "productivity"
  | "support";

/** Sensible category per fixture toolkit slug. */
export const TOOLKIT_CATEGORY: Record<string, ToolkitCategory> = {
  gmail: "comms",
  slack: "comms",
  hubspot: "crm",
  salesforce: "crm",
  google_sheets: "files",
  stripe: "payments",
  notion: "productivity",
  zendesk: "support",
};

/**
 * Live directory: map Composio's category names onto our six buckets.
 * First match wins; unknown categories fall back to "productivity".
 */
const CATEGORY_HINTS: Array<[RegExp, ToolkitCategory]> = [
  [/support|helpdesk|ticket/, "support"],
  [/payment|billing|finance|accounting|commerce/, "payments"],
  [/crm|sales|marketing/, "crm"],
  [/communicat|chat|email|messag|social/, "comms"],
  [/file|document|storage|drive|spreadsheet/, "files"],
];

export function categoryFromHints(categories: string[] | undefined): ToolkitCategory | null {
  for (const c of categories ?? []) {
    for (const [re, cat] of CATEGORY_HINTS) if (re.test(c)) return cat;
  }
  return null;
}

export const TOOLKIT_CATEGORIES: ToolkitCategory[] = [
  "comms",
  "crm",
  "files",
  "payments",
  "productivity",
  "support",
];

/** The v1 five — enabled-by-default for backward compat (zero regression). */
export const V1_TOOLKIT_SLUGS = ["gmail", "google_sheets", "slack", "hubspot", "notion"];

/** v1 appKey → toolkitSlug (ComposioApp carries both). */
const V1_APPKEY_TO_TOOLKIT: Record<string, string> = Object.fromEntries(
  V1_COMPOSIO_APPS.map((a) => [a.appKey, a.toolkitSlug]),
);

export interface TierBreakdown {
  low: number;
  medium: number;
  high: number;
  unclassified: number;
}

export interface ToolkitDirectoryEntry {
  toolkitSlug: string;
  appKey: string;
  label: string;
  description: string;
  category: ToolkitCategory;
  connected: boolean;
  enabled: boolean;
  toolCount: number;
  tierBreakdown: TierBreakdown;
}

/** Known toolkit slugs from the active router (live with a key, fixtures otherwise). */
export async function listKnownToolkits(): Promise<string[]> {
  return (await getToolRouter().listToolkits()).map((t) => t.toolkitSlug);
}

/**
 * Is this toolkit enabled for the workspace? Explicit row wins; otherwise
 * the v1 five default to enabled (backward compat), everything else to
 * disabled (firehose is opt-in).
 */
export async function isToolkitEnabled(
  workspaceId: string,
  toolkitSlug: string,
): Promise<boolean> {
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.workspaceToolkit.findFirst({
      where: { workspaceId, toolkitSlug },
      select: { enabled: true },
    }),
  );
  if (row) return row.enabled;
  return V1_TOOLKIT_SLUGS.includes(toolkitSlug);
}

/**
 * Resolve a tool slug to its toolkit slug for the workspace.
 * Order: workspace's discovered catalog (live path) → v1 pinned catalog
 * fallback (baseline tools are known globally). Unknown tools resolve to
 * null and the gate refuses them fail-closed.
 */
export async function resolveToolkitForTool(
  workspaceId: string,
  toolName: string,
): Promise<string | null> {
  const slug = toolName.toUpperCase();
  const catalogRow = await withWorkspaceScope(workspaceId, (tx) =>
    tx.composioToolCatalog.findFirst({
      where: { workspaceId, toolSlug: slug },
      select: { toolkitSlug: true },
    }),
  );
  if (catalogRow) return catalogRow.toolkitSlug;
  const v1 = V1_ACTION_CATALOG.find((t) => t.slug === slug);
  if (v1) return V1_APPKEY_TO_TOOLKIT[v1.appKey] ?? null;
  return null;
}

/**
 * Record an explicit enable/disable decision for a workspace toolkit.
 * Throws for unknown toolkit slugs (fail-closed: no enablement row for a
 * toolkit that isn't in the router's directory).
 */
export async function setToolkitEnabled(opts: {
  workspaceId: string;
  toolkitSlug: string;
  enabled: boolean;
  userId: string | null;
}): Promise<{ toolkitSlug: string; enabled: boolean }> {
  const known = await listKnownToolkits();
  if (!known.includes(opts.toolkitSlug)) {
    throw new BadRequestError(
      `Unknown toolkit "${opts.toolkitSlug}" — enablement refused (known: ${known.join(", ")})`,
    );
  }
  const router = getToolRouter();
  const toolkits = await router.listToolkits();
  const meta = toolkits.find((t) => t.toolkitSlug === opts.toolkitSlug);
  await withWorkspaceScope(opts.workspaceId, (tx) =>
    tx.workspaceToolkit.upsert({
      where: {
        workspaceId_toolkitSlug: {
          workspaceId: opts.workspaceId,
          toolkitSlug: opts.toolkitSlug,
        },
      },
      update: {
        enabled: opts.enabled,
        enabledBy: opts.userId,
        enabledAt: new Date(),
        appKey: meta?.appKey ?? null,
      },
      create: {
        workspaceId: opts.workspaceId,
        toolkitSlug: opts.toolkitSlug,
        appKey: meta?.appKey ?? null,
        enabledBy: opts.userId,
        enabled: opts.enabled,
      },
    }),
  );
  return { toolkitSlug: opts.toolkitSlug, enabled: opts.enabled };
}

/** List the full directory with per-workspace state (spec §7 "Actions → Toolkits"). */
export async function listDirectory(
  workspaceId: string,
): Promise<ToolkitDirectoryEntry[]> {
  const router = getToolRouter();
  const toolkits = await router.listToolkits();
  const connections = await listConnections(workspaceId);
  const connectedAppKeys = new Set(
    connections.filter((c) => c.status === "connected").map((c) => c.appKey),
  );

  const [enabledRows, catalogRows] = await Promise.all([
    withWorkspaceScope(workspaceId, (tx) =>
      tx.workspaceToolkit.findMany({
        where: { workspaceId },
        select: { toolkitSlug: true, enabled: true },
      }),
    ),
    withWorkspaceScope(workspaceId, (tx) =>
      tx.composioToolCatalog.findMany({
        where: { workspaceId },
        select: { toolkitSlug: true, toolSlug: true, description: true, appKey: true },
      }),
    ),
  ]);
  const enabledBySlug = new Map(enabledRows.map((r) => [r.toolkitSlug, r.enabled]));
  const catalogByToolkit = new Map<string, typeof catalogRows>();
  for (const row of catalogRows) {
    const arr = catalogByToolkit.get(row.toolkitSlug) ?? [];
    arr.push(row);
    catalogByToolkit.set(row.toolkitSlug, arr);
  }

  const entries: ToolkitDirectoryEntry[] = [];
  for (const tk of toolkits) {
    const catalogTools = catalogByToolkit.get(tk.toolkitSlug);
    // Counts/breakdown: the workspace's discovered catalog when a refresh
    // has seeded it; the fixture tool list before that (pre-connect view).
    let toolCount: number;
    let breakdown: TierBreakdown = { low: 0, medium: 0, high: 0, unclassified: 0 };
    if (catalogTools && catalogTools.length > 0) {
      toolCount = catalogTools.length;
      for (const t of catalogTools) {
        const d = deriveTier(t.toolSlug, t.description, t.appKey);
        if (!d.classified) breakdown.unclassified += 1;
        else breakdown[d.tier] += 1;
      }
    } else if (tk.toolCount !== undefined) {
      // Live directory, toolkit not discovered for this workspace yet: show
      // Composio's advertised count without fetching every toolkit's tools
      // (hundreds of calls per page load). Until a catalog refresh derives
      // their tiers they are unclassified — and the gate treats an
      // undiscovered tool exactly that way (conservative floor).
      toolCount = tk.toolCount;
      breakdown = { low: 0, medium: 0, high: 0, unclassified: tk.toolCount };
    } else {
      const fixtureTools = await router.getToolkitTools(tk.toolkitSlug);
      toolCount = fixtureTools.length;
      for (const t of fixtureTools) {
        const d = deriveTier(t.slug, t.description, tk.appKey);
        if (!d.classified) breakdown.unclassified += 1;
        else breakdown[d.tier] += 1;
      }
    }
    const explicit = enabledBySlug.get(tk.toolkitSlug);
    entries.push({
      toolkitSlug: tk.toolkitSlug,
      appKey: tk.appKey,
      label: tk.label,
      description: tk.description,
      category: TOOLKIT_CATEGORY[tk.toolkitSlug] ?? categoryFromHints(tk.categories) ?? "productivity",
      connected: connectedAppKeys.has(tk.appKey),
      enabled: explicit ?? V1_TOOLKIT_SLUGS.includes(tk.toolkitSlug),
      toolCount,
      tierBreakdown: breakdown,
    });
  }
  // Stable order: v1 five first (they're the workspace's working set), then
  // the rest alphabetically — the firehose is browsable, not dumped.
  entries.sort((a, b) => {
    const ai = V1_TOOLKIT_SLUGS.indexOf(a.toolkitSlug);
    const bi = V1_TOOLKIT_SLUGS.indexOf(b.toolkitSlug);
    if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    return a.label.localeCompare(b.label);
  });
  return entries;
}

/** Raw enablement rows (audit/debug use). */
export async function listWorkspaceToolkits(workspaceId: string) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.workspaceToolkit.findMany({
      where: { workspaceId },
      orderBy: { toolkitSlug: "asc" },
      select: {
        id: true,
        toolkitSlug: true,
        appKey: true,
        enabled: true,
        enabledBy: true,
        enabledAt: true,
      },
    }),
  );
}
