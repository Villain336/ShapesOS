// Marketr — Phase 14: bulk-action detection (slice 5, trust ladder).
//
// A "bulk" action is a destructive/write call whose args carry an array of
// targets (e.g. ids: ["m-1","m-2"]). Spec §3: bulk destructive operations
// need PER-ITEM review — the approver must confirm the exact item set, and
// execution fails closed when the confirmed count doesn't match what was
// reviewed. Pure and fixture-testable.

export interface BulkInfo {
  /** The arg field holding the target list (e.g. "ids"). */
  field: string;
  /** Number of items the action will touch. */
  count: number;
  /** First few items for the review UI. */
  preview: unknown[];
}

function isTargetList(v: unknown): v is unknown[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  return v.every(
    (x) =>
      typeof x === "string" ||
      typeof x === "number" ||
      (typeof x === "object" && x !== null && ("id" in x || "email" in x)),
  );
}

/**
 * Find the largest target list in the top-level args. Returns null for
 * single-target actions (count 1 is not bulk — no per-item review needed).
 */
export function extractBulkItems(args: Record<string, unknown>): BulkInfo | null {
  let best: BulkInfo | null = null;
  for (const [field, value] of Object.entries(args)) {
    if (!isTargetList(value)) continue;
    const info: BulkInfo = {
      field,
      count: value.length,
      preview: value.slice(0, 5),
    };
    if (value.length > 1 && (!best || value.length > best.count)) best = info;
  }
  return best;
}

/** Human-readable bulk line for the approval summary / confirm dialog. */
export function describeBulk(bulk: BulkInfo): string {
  const more = bulk.count > bulk.preview.length ? ` (+${bulk.count - bulk.preview.length} more)` : "";
  return `${bulk.count} items via "${bulk.field}": ${bulk.preview.map((x) => JSON.stringify(x)).join(", ")}${more}`;
}
