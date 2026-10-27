// ShapesOS - side-by-side comparison of the DECLARED plan variants of a drafted
// mission. Pure and deterministic: it only lays existing step data next to each
// other. These are template variants, not independent runs, and nothing here
// estimates time or cost.

export interface CompareStep {
  key: string;
  title: string;
  kind: string;
  executor: string;
  tier: number;
  checkpointAfter: boolean;
}

export interface CompareInput {
  id: string;
  label: string;
  steps: CompareStep[];
}

export type CellDiff = "same" | "changed" | "missing";

export interface CompareRow {
  key: string;
  title: string;
  /** One cell per input variant, in input order; null when that variant has no such step. */
  cells: (CompareStep | null)[];
  /** Per variant, relative to the first variant (the baseline): same / changed / missing. */
  diff: CellDiff[];
}

export interface CompareResult {
  rows: CompareRow[];
  /** Per variant: how many baseline steps it lacks, and how many it has that the baseline lacks. */
  summary: { id: string; label: string; missingFromBaseline: number; notInBaseline: number; changed: number }[];
}

const same = (a: CompareStep, b: CompareStep) => a.title === b.title && a.kind === b.kind && a.executor === b.executor && a.tier === b.tier && a.checkpointAfter === b.checkpointAfter;

export function comparePlans(variants: CompareInput[]): CompareResult {
  // Row order: the baseline's order first, then any step only other variants have, in first-seen order.
  const order: string[] = [];
  for (const v of variants) for (const s of v.steps) if (!order.includes(s.key)) order.push(s.key);
  const baseline = variants[0];
  const rows: CompareRow[] = order.map((key) => {
    const cells = variants.map((v) => v.steps.find((s) => s.key === key) ?? null);
    const base = baseline?.steps.find((s) => s.key === key) ?? null;
    const diff = cells.map((c): CellDiff => (c === null ? "missing" : base === null ? "changed" : same(c, base) ? "same" : "changed"));
    const title = (cells.find((c) => c !== null) as CompareStep).title;
    return { key, title, cells, diff };
  });
  const summary = variants.map((v, i) => ({
    id: v.id,
    label: v.label,
    missingFromBaseline: i === 0 ? 0 : rows.filter((r) => r.cells[0] !== null && r.cells[i] === null).length,
    notInBaseline: i === 0 ? 0 : rows.filter((r) => r.cells[0] === null && r.cells[i] !== null).length,
    changed: i === 0 ? 0 : rows.filter((r) => r.cells[0] !== null && r.cells[i] !== null && r.diff[i] === "changed").length,
  }));
  return { rows, summary };
}
