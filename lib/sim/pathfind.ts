// ShapesOS — Phase 19B (WS=engine): A* on the road graph (driving) and the
// walk graph (walking). Written here in pure TS — no dependency; the 3D
// client's navmesh (recast-navigation-js) is a milestone-3 concern.
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
// Cost = travel time in seconds (edge length / speed). The heuristic is the
// straight-line distance at the graph's top speed, which never overestimates,
// so A* returns a fastest route. Ties break on insertion order, so the same
// graph always gives the same route (determinism). A trip's output is a
// planned path with a timestamp per point — what the client interpolates.

import type { TownLayout } from "./layout";

export type TravelMode = "walk" | "drive";

/** Walking speed (m/s) — 5 km/h. */
export const WALK_SPEED_MS = 1.4;

interface Arc {
  to: string;
  seconds: number;
}

export interface PathGraph {
  nodes: Map<string, { x: number; y: number }>;
  adj: Map<string, Arc[]>;
  /** Fastest speed on the graph (m/s), for the admissible heuristic. */
  maxSpeed: number;
}

function addArc(g: PathGraph, from: string, to: string, seconds: number): void {
  let list = g.adj.get(from);
  if (!list) g.adj.set(from, (list = []));
  list.push({ to, seconds });
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The driving graph: one-way edges only from → to; cost = length / speed. */
export function roadGraph(layout: Pick<TownLayout, "roads">): PathGraph {
  const g: PathGraph = { nodes: new Map(layout.roads.nodes.map((n) => [n.id, { x: n.x, y: n.y }])), adj: new Map(), maxSpeed: 0 };
  for (const e of layout.roads.edges) {
    const a = g.nodes.get(e.from);
    const b = g.nodes.get(e.to);
    if (!a || !b) continue;
    const speed = e.speedKph / 3.6;
    g.maxSpeed = Math.max(g.maxSpeed, speed);
    const s = dist(a, b) / speed;
    addArc(g, e.from, e.to, s);
    if (!e.oneWay) addArc(g, e.to, e.from, s);
  }
  if (g.maxSpeed === 0) g.maxSpeed = 1;
  return g;
}

/** The walking graph: undirected, at `speed` m/s. */
export function walkGraph(layout: Pick<TownLayout, "walkways">, speed = WALK_SPEED_MS): PathGraph {
  const g: PathGraph = { nodes: new Map(layout.walkways.nodes.map((n) => [n.id, { x: n.x, y: n.y }])), adj: new Map(), maxSpeed: speed };
  for (const e of layout.walkways.edges) {
    const a = g.nodes.get(e.from);
    const b = g.nodes.get(e.to);
    if (!a || !b) continue;
    const s = dist(a, b) / speed;
    addArc(g, e.from, e.to, s);
    addArc(g, e.to, e.from, s);
  }
  return g;
}

/** Binary min-heap on (f, seq). */
class OpenSet {
  private heap: Array<{ id: string; f: number; seq: number }> = [];
  private seq = 0;
  get size(): number {
    return this.heap.length;
  }
  push(id: string, f: number): void {
    const h = this.heap;
    h.push({ id, f, seq: this.seq++ });
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(h[p]!, h[i]!)) break;
      [h[p], h[i]] = [h[i]!, h[p]!];
      i = p;
    }
  }
  pop(): { id: string; f: number } | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
        if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i]!, h[m]!];
        i = m;
      }
    }
    return top;
  }
  private less(a: { f: number; seq: number }, b: { f: number; seq: number }): boolean {
    return a.f < b.f || (a.f === b.f && a.seq < b.seq);
  }
}

/** Fastest route from → to, or null when there is none (unknown node, disconnected, one-way). */
export function astar(g: PathGraph, from: string, to: string): { nodes: string[]; seconds: number } | null {
  const goal = g.nodes.get(to);
  if (!g.nodes.has(from) || !goal) return null;
  if (from === to) return { nodes: [from], seconds: 0 };
  const h = (id: string) => dist(g.nodes.get(id)!, goal) / g.maxSpeed;
  const gScore = new Map<string, number>([[from, 0]]);
  const came = new Map<string, string>();
  const closed = new Set<string>();
  const open = new OpenSet();
  open.push(from, h(from));
  while (open.size > 0) {
    const cur = open.pop()!;
    if (closed.has(cur.id)) continue;
    if (cur.id === to) {
      const nodes = [to];
      let n = to;
      while (came.has(n)) {
        n = came.get(n)!;
        nodes.push(n);
      }
      return { nodes: nodes.reverse(), seconds: gScore.get(to)! };
    }
    closed.add(cur.id);
    const base = gScore.get(cur.id)!;
    for (const arc of g.adj.get(cur.id) ?? []) {
      if (closed.has(arc.to)) continue;
      const cand = base + arc.seconds;
      if (cand < (gScore.get(arc.to) ?? Infinity)) {
        gScore.set(arc.to, cand);
        came.set(arc.to, cur.id);
        open.push(arc.to, cand + h(arc.to));
      }
    }
  }
  return null;
}

export interface PathPoint {
  x: number;
  y: number;
  /** Sim second (since the run started) the resident is at this point. */
  t: number;
}

export interface PlannedPath {
  mode: TravelMode;
  points: PathPoint[];
}

/** Timestamp a route: each node at departure + cumulative travel time (whole seconds). */
export function timedPath(g: PathGraph, mode: TravelMode, nodes: readonly string[], departSecond: number): PlannedPath {
  const points: PathPoint[] = [];
  let elapsed = 0;
  let prev: { x: number; y: number } | null = null;
  let prevId: string | null = null;
  for (const id of nodes) {
    const p = g.nodes.get(id);
    if (!p) throw new Error(`timedPath: unknown node "${id}"`);
    if (prev && prevId) {
      const arc = (g.adj.get(prevId) ?? []).find((a) => a.to === id);
      elapsed += arc ? arc.seconds : dist(prev, p) / g.maxSpeed;
    }
    points.push({ x: p.x, y: p.y, t: departSecond + Math.round(elapsed) });
    prev = p;
    prevId = id;
  }
  return { mode, points };
}
