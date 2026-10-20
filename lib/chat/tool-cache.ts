// ShapesOS — Phase 17 (latency, A8): the short-lived cache for `safe`
// read-tool results.
//
// A turn (and the next one, seconds later) often asks the same read twice —
// the model re-reads keywords after a draft, a follow-up question re-runs
// the same ranking summary. Within TOOL_CACHE_TTL_MS the result is reused,
// keyed on workspace + project + tool + its arguments (stable JSON).
//
// In-process on purpose: one turn runs on one instance, so a per-process
// map already serves the repeats inside a turn and across the quick
// follow-ups on the same replica; a miss on another replica just runs the
// read again. Nothing correctness-critical lives here.
//
// Only PURE database reads are cacheable (CACHEABLE_TOOLS): a "safe" tool
// that changes turn state (load_skill), moves a sandbox or browser
// (git_*, read_file, browser_*) or reads something that changes under a
// running task is never cached. Every write that goes through the tool gate
// (a non-safe tool executing, confirmed or auto-approved) drops the
// workspace's entries, so a read after the agent's own write is fresh.

import type { ToolResult } from "./tools";

export const TOOL_CACHE_TTL_MS = 45_000;
export const TOOL_CACHE_MAX = 1_000;

/** Pure reads of workspace / project data (deterministic for the same arguments within seconds). */
export const CACHEABLE_TOOLS: ReadonlySet<string> = new Set([
  "get_keywords",
  "get_rankings",
  "get_competitors",
  "get_content",
  "get_alerts",
  "get_visibility_score",
  "get_workflows",
  "automation_flow_status",
  "ops_accounting_report",
  "ops_list_manufacturing_orders",
  "ops_pos_overview",
  "ops_payroll_overview",
  "ops_events_overview",
  "ops_store_overview",
  "ops_list_stock_by_location",
  "ops_operations_summary",
  "twin_site_state",
  "twin_find",
  "app_list_records",
]);

/** JSON with sorted keys, so {a,b} and {b,a} share a key. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export function toolCacheKey(input: { workspaceId: string; projectId: string; tool: string; args: Record<string, unknown> }): string {
  return `${input.workspaceId}:${input.projectId}:${input.tool}:${stableJson(input.args ?? {})}`;
}

export class ToolResultCache {
  private readonly map = new Map<string, { at: number; result: ToolResult }>();
  hits = 0;
  misses = 0;
  constructor(
    private readonly ttlMs = TOOL_CACHE_TTL_MS,
    private readonly max = TOOL_CACHE_MAX,
    private readonly now: () => number = Date.now,
  ) {}
  get(key: string): ToolResult | null {
    const hit = this.map.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) {
      this.hits++;
      return hit.result;
    }
    if (hit) this.map.delete(key);
    this.misses++;
    return null;
  }
  set(key: string, result: ToolResult): void {
    this.map.delete(key);
    this.map.set(key, { at: this.now(), result });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  /** A write happened in the workspace: its reads are stale. */
  invalidateWorkspace(workspaceId: string): void {
    for (const k of [...this.map.keys()]) if (k.startsWith(`${workspaceId}:`)) this.map.delete(k);
  }
  get size(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

export const toolResultCache = new ToolResultCache();

export function isCacheableTool(name: string): boolean {
  return CACHEABLE_TOOLS.has(name);
}
