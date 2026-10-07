// ShapesOS — Phase 19B (WS=engine): the procedural default town.
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
// A town exists with no art: a street grid from a seed and a size.
//
//   small   4 × 4 blocks (≈ 50–150 residents)     medium  6 × 6 blocks (up to 500)
//
// The centre blocks are downtown (your store, two competitor storefronts,
// cafés, offices), one corner is an industrial park of workplaces, one or
// two blocks are parks, the rest are homes. The two middle streets are
// 4-lane avenues (50 km/h); the others are 2-lane streets (30 km/h), a few of
// them one-way. Every street has sidewalks on the walk graph. Billboards
// stand beside the avenues. Pure and deterministic per (seed, size).

import { rngFor, type Rng } from "./rng";
import type { District, DistrictKind, GraphNode, Lot, LotKind, Rect, RoadEdge, TownLayout, WalkEdge } from "./layout";

export type TownSize = "small" | "medium";

export interface GenerateTownOptions {
  seed: number;
  size: TownSize;
  name?: string;
}

const BLOCK = 120;
const MARGIN = 14;
const SIDEWALK_OFFSET = 7;

type BlockKind = "commercial" | "industrial" | "park" | "residential";

function blockKinds(n: number, rng: Rng): BlockKind[][] {
  const grid: BlockKind[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => "residential" as BlockKind));
  const mid = Math.floor(n / 2);
  // Downtown: the 2×2 (small) or 2×2 + ring (medium) around the centre.
  for (const [i, j] of [
    [mid - 1, mid - 1],
    [mid - 1, mid],
    [mid, mid - 1],
    [mid, mid],
  ] as const) grid[i]![j] = "commercial";
  // Industrial corner (seeded which one).
  const corner = rng.int(0, 3);
  const ci = corner < 2 ? 0 : n - 1;
  const cj = corner % 2 === 0 ? 0 : n - 1;
  grid[ci]![cj] = "industrial";
  if (n >= 6) grid[ci]![cj === 0 ? 1 : n - 2] = "industrial";
  // Parks: one (small) or two (medium), on residential blocks.
  const parks = n >= 6 ? 2 : 1;
  let placed = 0;
  for (let guard = 0; placed < parks && guard < 100; guard++) {
    const i = rng.int(0, n - 1);
    const j = rng.int(0, n - 1);
    if (grid[i]![j] !== "residential") continue;
    grid[i]![j] = "park";
    placed += 1;
  }
  return grid;
}

function boundingRect(rects: Rect[]): Rect {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const DISTRICT_NAMES: Record<BlockKind, string> = {
  commercial: "Downtown",
  industrial: "Works district",
  park: "Green belt",
  residential: "Residential",
};
const DISTRICT_KIND: Record<BlockKind, DistrictKind> = { commercial: "commercial", industrial: "industrial", park: "park", residential: "residential" };

const COMPETITOR_NAMES = ["Corner Mart", "Main St Goods", "Value Depot", "City Market"];
const CAFE_NAMES = ["Bean There", "Morning Cup", "Daily Grind", "Hearth Café", "Steam Room", "Common Table"];
const WORK_NAMES = ["Harbor Offices", "Plaza Tower", "Riverside Studio", "Metro Clinic", "Civic Center", "Northgate Works", "Foundry Hall", "Logistics Yard", "Assembly Plant", "Tech Park"];

/** The procedural default town for (seed, size). */
export function generateTown(opts: GenerateTownOptions): TownLayout {
  const n = opts.size === "medium" ? 6 : 4;
  const rng = rngFor(opts.seed, `town:${opts.size}`);
  const kinds = blockKinds(n, rng.fork("blocks"));
  const mid = Math.floor(n / 2);

  // ── Roads: intersections on an (n+1)² grid ──────────────────────────────
  const roadNodes: GraphNode[] = [];
  const walkNodes: GraphNode[] = [];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      roadNodes.push({ id: `r-${i}-${j}`, x: j * BLOCK, y: i * BLOCK });
      walkNodes.push({ id: `w-${i}-${j}`, x: j * BLOCK + SIDEWALK_OFFSET, y: i * BLOCK + SIDEWALK_OFFSET });
    }
  }
  const roadEdges: RoadEdge[] = [];
  const walkEdges: WalkEdge[] = [];
  const oneWayRng = rng.fork("oneway");
  let oneWays = 0;
  const maxOneWays = n >= 6 ? 4 : 2;
  const addStreet = (a: [number, number], b: [number, number], avenue: boolean) => {
    const from = `r-${a[0]}-${a[1]}`;
    const to = `r-${b[0]}-${b[1]}`;
    // One-way only on interior side streets (the grid stays strongly connected).
    const interior = a[0] > 0 && a[0] < n && a[1] > 0 && a[1] < n && b[0] > 0 && b[0] < n && b[1] > 0 && b[1] < n;
    const oneWay = !avenue && interior && oneWays < maxOneWays && oneWayRng.chance(0.35);
    if (oneWay) oneWays += 1;
    roadEdges.push({ id: `${from}~${to}`, from, to, lanes: avenue ? 4 : oneWay ? 1 : 2, speedKph: avenue ? 50 : 30, oneWay });
    walkEdges.push({ id: `w-${a[0]}-${a[1]}~w-${b[0]}-${b[1]}`, from: `w-${a[0]}-${a[1]}`, to: `w-${b[0]}-${b[1]}` });
  };
  for (let i = 0; i <= n; i++) for (let j = 0; j < n; j++) addStreet([i, j], [i, j + 1], i === mid);
  for (let j = 0; j <= n; j++) for (let i = 0; i < n; i++) addStreet([i, j], [i + 1, j], j === mid);

  // ── Lots: each block split 2 × 2 (a park is one lot) ────────────────────
  const lots: Lot[] = [];
  const blockRects: Record<BlockKind, Rect[]> = { commercial: [], industrial: [], park: [], residential: [] };
  const lotRng = rng.fork("lots");
  let competitors = 0;
  let cafes = 0;
  let works = 0;
  let yours = false;
  const homeCapacity = opts.size === "medium" ? 6 : 4;
  const nearestCorner = (i: number, j: number, cx: number, cy: number): [number, number] => {
    let best: [number, number] = [i, j];
    let bestD = Infinity;
    for (const [di, dj] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ] as const) {
      const d = Math.hypot((j + dj) * BLOCK - cx, (i + di) * BLOCK - cy);
      if (d < bestD) {
        bestD = d;
        best = [i + di, j + dj];
      }
    }
    return best;
  };
  const pushLot = (i: number, j: number, kind: LotKind, name: string, rect: Rect, extra: Partial<Lot> = {}) => {
    const [ci, cj] = nearestCorner(i, j, rect.x + rect.w / 2, rect.y + rect.h / 2);
    lots.push({ id: `${kind}-${lots.length + 1}`, districtId: `d-${kinds[i]![j]}`, kind, name, rect, roadNode: `r-${ci}-${cj}`, walkNode: `w-${ci}-${cj}`, ...extra });
  };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const kind = kinds[i]![j]!;
      const bx = j * BLOCK + MARGIN;
      const by = i * BLOCK + MARGIN;
      const inner = BLOCK - 2 * MARGIN;
      blockRects[kind].push({ x: j * BLOCK, y: i * BLOCK, w: BLOCK, h: BLOCK });
      if (kind === "park") {
        pushLot(i, j, "park", `${["Elm", "Lake", "Hill", "Mill"][lotRng.int(0, 3)]} Park`, { x: bx, y: by, w: inner, h: inner });
        continue;
      }
      const half = (inner - 6) / 2;
      for (let q = 0; q < 4; q++) {
        const rect: Rect = { x: bx + (q % 2) * (half + 6), y: by + Math.floor(q / 2) * (half + 6), w: half, h: half };
        if (kind === "residential") {
          pushLot(i, j, "home", `${100 + lots.length} ${["Oak", "Pine", "Maple", "Birch", "Cedar"][lotRng.int(0, 4)]} St`, rect, { capacity: homeCapacity });
        } else if (kind === "industrial") {
          pushLot(i, j, "work", WORK_NAMES[works++ % WORK_NAMES.length]!, rect, { capacity: 60 });
        } else {
          // Downtown: first your store, then competitors, cafés and offices in turn.
          if (!yours) {
            yours = true;
            pushLot(i, j, "shop", "Your store", rect, { owner: "you" });
          } else if (competitors < 2 && q % 2 === 1) {
            pushLot(i, j, "shop", COMPETITOR_NAMES[competitors++]!, rect, { owner: "competitor" });
          } else if (cafes < (n >= 6 ? 3 : 2) && q % 2 === 0) {
            pushLot(i, j, "cafe", CAFE_NAMES[cafes++]!, rect);
          } else {
            pushLot(i, j, "work", WORK_NAMES[works++ % WORK_NAMES.length]!, rect, { capacity: 40 });
          }
        }
      }
    }
  }
  // Billboards beside the avenues (just off the curb).
  const boards = n >= 6 ? 4 : 3;
  for (let b = 0; b < boards; b++) {
    const along = 1 + Math.floor(((b + 0.5) * (n - 1)) / boards);
    const horizontal = b % 2 === 0;
    const x = horizontal ? along * BLOCK + 30 : mid * BLOCK + 4;
    const y = horizontal ? mid * BLOCK + 4 : along * BLOCK + 30;
    const i = Math.min(n - 1, Math.floor(y / BLOCK));
    const j = Math.min(n - 1, Math.floor(x / BLOCK));
    pushLot(i, j, "billboard", `Billboard ${b + 1}`, { x, y, w: horizontal ? 24 : 4, h: horizontal ? 4 : 24 });
  }

  const districts: District[] = (Object.keys(blockRects) as BlockKind[])
    .filter((k) => blockRects[k].length > 0)
    .map((k) => ({ id: `d-${k}`, name: DISTRICT_NAMES[k], kind: DISTRICT_KIND[k], rect: boundingRect(blockRects[k]) }));

  return {
    version: 1,
    name: opts.name ?? `${opts.size === "medium" ? "Medium" : "Small"} town #${opts.seed}`,
    source: "generated",
    size: { width: n * BLOCK, height: n * BLOCK },
    districts,
    lots,
    roads: { nodes: roadNodes, edges: roadEdges },
    walkways: { nodes: walkNodes, edges: walkEdges },
  };
}
