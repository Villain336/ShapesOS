// Marketr — Knowledge Brain: minimal force-directed layout.
//
// A small, dependency-free force simulation for the corpus brain canvas
// (~48 nodes). Pure data in / pure data out so it is unit-testable:
//   const sim = createLayout(nodes, edges, { width, height });
//   sim.step(); // advance one tick
//   sim.positions(); // Map<id, {x, y}>
//   sim.pin(id, x, y); sim.unpin(id);
//
// Forces: Coulomb-style repulsion (capped), Hooke springs on edges,
// per-pillar cluster gravity, and weak centering. Deterministic initial
// placement on a golden-angle spiral so first paint is already sensible.

export interface LayoutNode {
  id: string;
  pillar: "marketing" | "growth" | "design";
  /** Visual radius in px (∝ chunk count). */
  radius: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
}

export interface LayoutOptions {
  width: number;
  height: number;
  /** Pillar anchor points in [0,1]² space; defaults spread the three pillars. */
  anchors?: Record<string, { x: number; y: number }>;
}

interface Body extends LayoutNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned: boolean;
}

const DEFAULT_ANCHORS = {
  marketing: { x: 0.28, y: 0.42 },
  growth: { x: 0.72, y: 0.38 },
  design: { x: 0.5, y: 0.74 },
};

const REPULSION = 7000;
const OVERLAP_K = 0.18;
const SPRING_K = 0.028;
const SPRING_LEN = 130;
const CLUSTER_K = 0.012;
const CENTER_K = 0.004;
const DAMPING = 0.82;
const MAX_V = 9;

export interface ForceLayout {
  step(): void;
  positions(): Map<string, { x: number; y: number; radius: number }>;
  pin(id: string, x: number, y: number): void;
  unpin(id: string): void;
  isPinned(id: string): boolean;
  /** Mean node speed — useful for "settled" detection in tests/UI. */
  meanSpeed(): number;
}

export function createLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  opts: LayoutOptions,
): ForceLayout {
  const { width, height } = opts;
  const anchors = opts.anchors ?? DEFAULT_ANCHORS;
  const cx = width / 2;
  const cy = height / 2;

  // Golden-angle spiral initial placement, offset per pillar so clusters
  // start near their anchors.
  const bodies = new Map<string, Body>();
  const perPillar = new Map<string, number>();
  nodes.forEach((n, i) => {
    const k = perPillar.get(n.pillar) ?? 0;
    perPillar.set(n.pillar, k + 1);
    const a = anchors[n.pillar] ?? { x: 0.5, y: 0.5 };
    const ang = k * 2.399963 + (i % 3) * 0.7;
    const rad = 40 + 26 * Math.sqrt(k);
    bodies.set(n.id, {
      ...n,
      x: a.x * width + Math.cos(ang) * rad,
      y: a.y * height + Math.sin(ang) * rad,
      vx: 0,
      vy: 0,
      pinned: false,
    });
  });

  const edgeList = edges.filter((e) => bodies.has(e.from) && bodies.has(e.to));

  function step(): void {
    const arr = [...bodies.values()];

    // Repulsion (O(n²); n≈48 is trivial).
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      if (a.pinned) continue;
      for (let j = i + 1; j < arr.length; j++) {
        const b = arr[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        const minD = a.radius + b.radius + 14;
        if (d2 < 1) {
          dx = (i - j) * 0.7 + 0.31;
          dy = (j - i) * 0.7 - 0.17;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        // Base repulsion, plus a strong separation term when node discs
        // overlap (keeps dense pillar clusters readable).
        let f = Math.min(REPULSION / d2, 8);
        if (d < minD) f += (minD - d) * OVERLAP_K;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        if (!b.pinned) {
          b.vx -= fx;
          b.vy -= fy;
        }
        a.vx += fx;
        a.vy += fy;
      }
    }

    // Springs.
    for (const e of edgeList) {
      const a = bodies.get(e.from)!;
      const b = bodies.get(e.to)!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - SPRING_LEN) * SPRING_K;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      if (!a.pinned) {
        a.vx += fx;
        a.vy += fy;
      }
      if (!b.pinned) {
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    // Pillar cluster gravity + weak centering + integrate.
    for (const b of arr) {
      if (b.pinned) continue;
      const a = anchors[b.pillar] ?? { x: 0.5, y: 0.5 };
      b.vx += (a.x * width - b.x) * CLUSTER_K;
      b.vy += (a.y * height - b.y) * CLUSTER_K;
      b.vx += (cx - b.x) * CENTER_K;
      b.vy += (cy - b.y) * CENTER_K;
      b.vx *= DAMPING;
      b.vy *= DAMPING;
      const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (sp > MAX_V) {
        b.vx = (b.vx / sp) * MAX_V;
        b.vy = (b.vy / sp) * MAX_V;
      }
      b.x += b.vx;
      b.y += b.vy;
      // Soft bounds.
      const m = 30;
      if (b.x < m) b.x = m;
      if (b.x > width - m) b.x = width - m;
      if (b.y < m) b.y = m;
      if (b.y > height - m) b.y = height - m;
    }
  }

  return {
    step,
    positions() {
      const out = new Map<string, { x: number; y: number; radius: number }>();
      for (const [id, b] of bodies) out.set(id, { x: b.x, y: b.y, radius: b.radius });
      return out;
    },
    pin(id, x, y) {
      const b = bodies.get(id);
      if (b) {
        b.pinned = true;
        b.x = x;
        b.y = y;
        b.vx = 0;
        b.vy = 0;
      }
    },
    unpin(id) {
      const b = bodies.get(id);
      if (b) b.pinned = false;
    },
    isPinned: (id) => bodies.get(id)?.pinned ?? false,
    meanSpeed() {
      const arr = [...bodies.values()].filter((b) => !b.pinned);
      if (!arr.length) return 0;
      return arr.reduce((s, b) => s + Math.sqrt(b.vx * b.vx + b.vy * b.vy), 0) / arr.length;
    },
  };
}
