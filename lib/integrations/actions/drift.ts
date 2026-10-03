// Marketr — Phase 15 slice 5: catalog drift detection (spec §1, §6).
//
// When the live catalog disagrees with the ComposioToolCatalog cache
// (tools added/removed/renamed), detectDrift() computes the diff and
// recordDriftReport() persists one ComposioCatalogDrift row per change.
// Removed tools keep their last-known cache rows (slice-1 behavior —
// refresh never deletes); the drift row is what flags them.
//
// Gate semantics (locked, never weakened):
// - ADDED tools are NOT in the cache. Proposing one falls through
//   resolveToolkitForTool() → null → the slice-2 universal conservative
//   floor (unclassified → HIGH-GATED: approval + second confirmation,
//   never auto-executable). No special-casing here — the battery asserts
//   the floor catches them.
// - REMOVED / RENAMED tools: tier overrides in
//   WorkspaceSettings.toolTierOverrides that reference the old slug
//   become STALE. getStaleOverrides() surfaces them; acknowledging the
//   drift row (the human's re-approval) clears the flag.
//
// RENAME HEURISTIC (documented): Composio renames keep the tool's
// human-facing metadata — a (removed-slug, added-slug) pair is treated
// as a rename when the normalized label AND normalized description are
// identical across the two slugs. Normalization = trim + collapse
// whitespace + lowercase. This deliberately over-matches on exact
// identity rather than fuzzy similarity: a false rename would hide a
// genuine remove/add pair, which is the riskier mistake (a removed tool
// silently treated as "still around under a new name" could misdirect
// its stale override). Paired renames are EXCLUDED from the removed[]
// and added[] sets.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  getToolRouter,
  type ComposioToolkitTool,
} from "@/lib/integrations/actions/discovery";
import { getToolTierOverrides } from "@/lib/integrations/actions/connections";

export type DriftChangeType = "added" | "removed" | "renamed";

export interface DriftRename {
  oldSlug: string;
  newSlug: string;
}

export interface CatalogDiff {
  toolkitSlug: string;
  appKey: string;
  added: string[];
  removed: string[];
  renamed: DriftRename[];
}

export interface DriftReport {
  id: string;
  appKey: string;
  toolkitSlug: string;
  changeType: DriftChangeType;
  toolSlug: string;
  oldSlug: string | null;
  detectedAt: Date;
  acknowledgedAt: Date | null;
}

export interface StaleOverride {
  /** The override key (old slug) that no longer maps to a live tool. */
  toolSlug: string;
  /** Human-readable reason: which change made it stale. */
  reason: string;
}

function normalize(s: string | null | undefined): string {
  return (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Diff a FRESH tool list (just discovered) against the CACHED tool list
 * for one toolkit. added = in fresh, not cached; removed = in cache, not
 * fresh; renamed = a removed slug + added slug pair with identical
 * normalized label AND description (pairs excluded from added/removed).
 */
export function diffToolLists(
  toolkitSlug: string,
  appKey: string,
  fresh: ComposioToolkitTool[],
  cached: Array<{ toolSlug: string; toolLabel: string | null; description: string | null }>,
): CatalogDiff {
  const cachedBySlug = new Map(cached.map((c) => [c.toolSlug, c]));
  const freshBySlug = new Map(fresh.map((f) => [f.slug, f]));

  const addedCandidates = fresh.filter((f) => !cachedBySlug.has(f.slug));
  const removedCandidates = cached.filter((c) => !freshBySlug.has(c.toolSlug));

  const renamed: DriftRename[] = [];
  const consumedAdded = new Set<string>();
  const consumedRemoved = new Set<string>();

  // Pair renames: a removed slug and an added slug with identical
  // normalized label AND description.
  for (const removed of removedCandidates) {
    const oldLabel = normalize(removed.toolLabel);
    const oldDesc = normalize(removed.description);
    const match = addedCandidates.find(
      (a) =>
        !consumedAdded.has(a.slug) &&
        normalize(a.label) === oldLabel &&
        normalize(a.description) === oldDesc,
    );
    if (match) {
      renamed.push({ oldSlug: removed.toolSlug, newSlug: match.slug });
      consumedAdded.add(match.slug);
      consumedRemoved.add(removed.toolSlug);
    }
  }

  return {
    toolkitSlug,
    appKey,
    added: addedCandidates
      .filter((a) => !consumedAdded.has(a.slug))
      .map((a) => a.slug),
    removed: removedCandidates
      .filter((r) => !consumedRemoved.has(r.toolSlug))
      .map((r) => r.toolSlug),
    renamed,
  };
}

/**
 * Detect catalog drift for one (workspace, app): re-run discovery for
 * the app's toolkit and diff against the ComposioToolCatalog cache rows.
 * Pure-ish: reads the cache under the workspace scope, asks the active
 * router (fixture unless COMPOSIO_API_KEY is set) for the fresh list.
 */
export async function detectDrift(
  workspaceId: string,
  appKey: string,
): Promise<CatalogDiff> {
  const router = getToolRouter();
  const toolkits = await router.listToolkits();
  const toolkit =
    toolkits.find((t) => t.appKey === appKey) ??
    toolkits.find((t) => t.toolkitSlug === appKey);
  if (!toolkit) {
    throw new Error(`No toolkit found for app "${appKey}"`);
  }
  const fresh = await router.getToolkitTools(toolkit.toolkitSlug);
  const cached = await withWorkspaceScope(workspaceId, (tx) =>
    tx.composioToolCatalog.findMany({
      where: { workspaceId, toolkitSlug: toolkit.toolkitSlug },
      select: { toolSlug: true, toolLabel: true, description: true },
    }),
  );
  return diffToolLists(toolkit.toolkitSlug, appKey, fresh, cached);
}

/**
 * Persist a diff as ComposioCatalogDrift rows (one per change).
 * Idempotent-ish: skips changes that already have an UNACKNOWLEDGED row
 * with the same (changeType, toolSlug, oldSlug), so a nightly rediff
 * before the human re-approves doesn't pile up duplicates. Returns the
 * number of NEW rows written.
 */
export async function recordDriftReport(
  workspaceId: string,
  diff: CatalogDiff,
): Promise<number> {
  const changes: Array<{
    changeType: DriftChangeType;
    toolSlug: string;
    oldSlug: string | null;
  }> = [
    ...diff.added.map((s) => ({ changeType: "added" as const, toolSlug: s, oldSlug: null })),
    ...diff.removed.map((s) => ({ changeType: "removed" as const, toolSlug: s, oldSlug: null })),
    ...diff.renamed.map((r) => ({
      changeType: "renamed" as const,
      toolSlug: r.newSlug,
      oldSlug: r.oldSlug,
    })),
  ];
  if (changes.length === 0) return 0;

  const existing = await withWorkspaceScope(workspaceId, (tx) =>
    tx.composioCatalogDrift.findMany({
      where: {
        workspaceId,
        toolkitSlug: diff.toolkitSlug,
        acknowledgedAt: null,
      },
      select: { changeType: true, toolSlug: true, oldSlug: true },
    }),
  );
  const seen = new Set(
    existing.map((e) => `${e.changeType}|${e.toolSlug}|${e.oldSlug ?? ""}`),
  );

  const fresh = changes.filter(
    (c) => !seen.has(`${c.changeType}|${c.toolSlug}|${c.oldSlug ?? ""}`),
  );
  for (const c of fresh) {
    seen.add(`${c.changeType}|${c.toolSlug}|${c.oldSlug ?? ""}`);
    await withWorkspaceScope(workspaceId, (tx) =>
      tx.composioCatalogDrift.create({
        data: {
          workspaceId,
          appKey: diff.appKey,
          toolkitSlug: diff.toolkitSlug,
          changeType: c.changeType,
          toolSlug: c.toolSlug,
          oldSlug: c.oldSlug,
        },
      }),
    );
  }
  return fresh.length;
}

/**
 * Unacknowledged drift reports for the workspace (newest first), with the
 * unacknowledged count for the Activity banner.
 */
export async function listDriftReports(
  workspaceId: string,
): Promise<{ reports: DriftReport[]; unacknowledgedCount: number }> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.composioCatalogDrift.findMany({
      where: { workspaceId },
      orderBy: { detectedAt: "desc" },
      select: {
        id: true,
        appKey: true,
        toolkitSlug: true,
        changeType: true,
        toolSlug: true,
        oldSlug: true,
        detectedAt: true,
        acknowledgedAt: true,
      },
    }),
  );
  const reports = rows.map((r) => ({
    ...r,
    changeType: r.changeType as DriftChangeType,
  }));
  return {
    reports,
    unacknowledgedCount: reports.filter((r) => r.acknowledgedAt === null).length,
  };
}

/**
 * Mark a drift row acknowledged (the human's re-approval of the change —
 * e.g. re-approving a stale tier override on the new slug). Scoped to
 * the workspace: cross-workspace ids fail closed.
 */
export async function acknowledgeDrift(
  workspaceId: string,
  driftId: string,
): Promise<DriftReport> {
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.composioCatalogDrift.update({
      where: { id: driftId, workspaceId },
      data: { acknowledgedAt: new Date() },
      select: {
        id: true,
        appKey: true,
        toolkitSlug: true,
        changeType: true,
        toolSlug: true,
        oldSlug: true,
        detectedAt: true,
        acknowledgedAt: true,
      },
    }),
  ).catch(() => null);
  if (!row) {
    throw new Error("Drift report not found");
  }
  return { ...row, changeType: row.changeType as DriftChangeType };
}

/**
 * Tier overrides whose slug no longer maps to a live tool — derived from
 * UNACKNOWLEDGED drift rows only (acknowledging is the re-approval, so it
 * clears the stale flag):
 * - override key === a REMOVED tool slug → the override can never apply
 *   again; re-approve to clear.
 * - override key === the OLD slug of a RENAMED tool → the override still
 *   references the dead slug, not the new one; re-approve (and re-point
 *   the override to the new slug) to clear.
 */
export async function getStaleOverrides(
  workspaceId: string,
): Promise<StaleOverride[]> {
  const overrides = await getToolTierOverrides(workspaceId);
  if (Object.keys(overrides).length === 0) return [];

  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.composioCatalogDrift.findMany({
      where: {
        workspaceId,
        acknowledgedAt: null,
        changeType: { in: ["removed", "renamed"] },
      },
      select: { changeType: true, toolSlug: true, oldSlug: true, toolkitSlug: true },
    }),
  );

  const stale: StaleOverride[] = [];
  for (const row of rows) {
    if (row.changeType === "removed" && overrides[row.toolSlug] !== undefined) {
      stale.push({
        toolSlug: row.toolSlug,
        reason: `Removed from the ${row.toolkitSlug} catalog — the override can never apply again.`,
      });
    }
    if (
      row.changeType === "renamed" &&
      row.oldSlug !== null &&
      overrides[row.oldSlug] !== undefined
    ) {
      stale.push({
        toolSlug: row.oldSlug,
        reason: `Renamed to ${row.toolSlug} — the override still points at the dead slug. Re-point it to the new slug and re-approve.`,
      });
    }
  }
  return stale;
}
