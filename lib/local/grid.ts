// Marketr — geo-grid geometry + run summarization (milestone 16).
//
// Pure functions: no database, no network. The service layer
// (lib/local/service.ts) calls these around provider.mapsSerp() calls.
// All geometry is deterministic so fixture tests cover it exactly.

import { MAX_GRID_CELLS_PER_RUN, MAX_GRID_SIZE, MIN_GRID_SIZE } from "../seo/local-cost";

export interface GridCell {
  row: number;
  col: number;
  lat: number;
  lng: number;
}

export interface GridCellResult extends GridCell {
  /** 1-based maps position of the client's business in this cell, null when absent. */
  position: number | null;
  /** Top business name in this cell (for the heatmap tooltip). */
  topBusiness: string | null;
}

export interface GridRunSummary {
  cells: number;
  /** % of cells where the client's business appeared (0–100). */
  coveragePct: number;
  /** Mean position over cells where present, null when absent everywhere. */
  avgPosition: number | null;
}

export interface GridRunDelta {
  coverageDeltaPct: number;
  /** Positive = improved (moved up). Null when either side has no positions. */
  avgPositionDelta: number | null;
}

const MILES_PER_DEG_LAT = 69;

/** Validate + clamp a requested grid size to the supported range. */
export function clampGridSize(size: number): number {
  const s = Math.floor(size);
  if (!Number.isFinite(s)) return 5;
  return Math.max(MIN_GRID_SIZE, Math.min(MAX_GRID_SIZE, s));
}

/**
 * Generate the cell centers for a square grid. Cells span [-radius, +radius]
 * miles from the center on both axes. A 5×5 grid at 5 miles covers a
 * 10×10-mile area; adjacent cells are 2.5 miles apart.
 */
export function generateGridCells(
  centerLat: number,
  centerLng: number,
  radiusMiles: number,
  gridSize: number,
): GridCell[] {
  const n = clampGridSize(gridSize);
  if (n * n > MAX_GRID_CELLS_PER_RUN) {
    throw new Error(`Grid ${n}×${n} exceeds the per-run cap of ${MAX_GRID_CELLS_PER_RUN} cells.`);
  }
  const radius = Math.max(0.1, radiusMiles);
  const cosLat = Math.cos((centerLat * Math.PI) / 180);
  const cells: GridCell[] = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      // -1 … +1 across the span (single row/col → 0 offset).
      const frac = (v: number) => (n === 1 ? 0 : (v / (n - 1)) * 2 - 1);
      const lat = centerLat + (frac(row) * radius) / MILES_PER_DEG_LAT;
      const lng = centerLng + (frac(col) * radius) / (MILES_PER_DEG_LAT * Math.max(0.2, cosLat));
      cells.push({ row, col, lat: round6(lat), lng: round6(lng) });
    }
  }
  return cells;
}

/** Normalize a business name for fuzzy matching against maps results. */
export function normalizeBusinessName(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find the client's business inside one cell's maps results.
 * Match = normalized client name is contained in (or contains) the listing
 * name. Returns the 1-based position or null when absent.
 */
export function matchClientPosition(
  items: Array<{ businessName: string }>,
  clientBusinessName: string,
): number | null {
  const needle = normalizeBusinessName(clientBusinessName);
  if (!needle) return null;
  const needleTokens = new Set(needle.split(" ").filter((t) => t.length > 2));
  for (let i = 0; i < items.length; i++) {
    const hay = normalizeBusinessName(items[i].businessName);
    if (!hay) continue;
    if (hay.includes(needle) || needle.includes(hay)) return i + 1;
    // Token-overlap fallback for "Acme Plumbing Co" vs "Acme Plumbing".
    if (needleTokens.size >= 2) {
      const hayTokens = new Set(hay.split(" ").filter((t) => t.length > 2));
      let overlap = 0;
      for (const t of needleTokens) if (hayTokens.has(t)) overlap++;
      if (overlap >= 2 && overlap / needleTokens.size >= 0.66) return i + 1;
    }
  }
  return null;
}

/** Summarize one completed grid run. */
export function summarizeGridRun(cells: GridCellResult[]): GridRunSummary {
  const positions = cells.map((c) => c.position).filter((p): p is number => p != null);
  return {
    cells: cells.length,
    coveragePct:
      cells.length === 0 ? 0 : Math.round((positions.length / cells.length) * 1000) / 10,
    avgPosition:
      positions.length === 0
        ? null
        : Math.round((positions.reduce((a, b) => a + b, 0) / positions.length) * 10) / 10,
  };
}

/** Week-over-week style diff between two run summaries (for alerts). */
export function diffGridRuns(prev: GridRunSummary, curr: GridRunSummary): GridRunDelta {
  return {
    coverageDeltaPct: Math.round((curr.coveragePct - prev.coveragePct) * 10) / 10,
    avgPositionDelta:
      prev.avgPosition == null || curr.avgPosition == null
        ? null
        : Math.round((prev.avgPosition - curr.avgPosition) * 10) / 10, // positive = improved
  };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
