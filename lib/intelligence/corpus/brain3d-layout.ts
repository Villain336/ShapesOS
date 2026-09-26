// Marketr — Knowledge Brain: 3D hemisphere layout.
//
// Pure, dependency-free mapping from corpus graph nodes to positions inside
// a brain-like volume (two ellipsoid hemispheres with a center gap).
// No WebGL here — the scene component consumes plain {x,y,z} data, so this
// module is unit-testable with node:test:
//
//   const placed = layoutBrain3D(nodes); // Brain3DNode[] with x/y/z/radius
//
// Invariants (all asserted in __tests__/brain3d-layout.test.ts):
// - every node respects the hemisphere gap (|x| >= GAP)
// - every node sits inside the ellipsoid volume
// - deterministic: same input → same output (seeded PRNG)
// - radius grows monotonically with chunk count
// - proposed (0-chunk) nodes get the minimum radius

import type { BrainPillar, BrainNode } from "./graph";

// ── Brain volume ─────────────────────────────────────────────────────────────

export const BRAIN_RX = 3.4; // ellipsoid semi-axes
export const BRAIN_RY = 2.5;
export const BRAIN_RZ = 2.7;
/** Half-width of the inter-hemisphere fissure (world units). */
export const BRAIN_GAP = 0.55;

const GOLDEN_ANGLE = 2.399963;
const LAYOUT_SEED = 1337;

export interface Brain3DInput {
  id: string;
  pillar: BrainPillar;
  chunks: number;
  kind: BrainNode["kind"];
}

export interface Brain3DNode extends Brain3DInput {
  x: number;
  y: number;
  z: number;
  /** Sphere radius in world units (∝ chunk count). */
  radius: number;
  /** -1 = left hemisphere, 1 = right hemisphere. */
  hemisphere: -1 | 1;
}

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Visual sphere radius for a chunk count (mirrors the 2D radiusOf curve). */
export function nodeRadius3D(chunks: number, kind: BrainNode["kind"]): number {
  if (kind === "proposed") return 0.11;
  const r = 0.1 + Math.sqrt(Math.max(chunks, 1)) * 0.028;
  return Math.min(0.46, Math.max(0.11, r));
}

/**
 * Pillar lobe bias: rotates each pillar's fibonacci points into its own
 * angular sector, so pillars read as brain lobes inside each hemisphere.
 */
const PILLAR_THETA_OFFSET: Record<BrainPillar, number> = {
  marketing: 0,
  growth: 2.1,
  design: 4.2,
};

/**
 * Lay nodes out in the brain volume. Nodes are grouped by pillar; within a
 * pillar they alternate hemispheres (each half-brain gets a mix of colors,
 * like a real brain), and within a hemisphere they sit on a fibonacci
 * lattice scaled into the ellipsoid, with seeded radial jitter so neurons
 * fill the volume rather than just the shell.
 */
export function layoutBrain3D(inputs: Brain3DInput[]): Brain3DNode[] {
  const rand = mulberry32(LAYOUT_SEED);
  // Stable order: pillar, then chunks desc, then id.
  const order: Record<BrainPillar, number> = { marketing: 0, growth: 1, design: 2 };
  const sorted = [...inputs].sort(
    (a, b) => order[a.pillar] - order[b.pillar] || b.chunks - a.chunks || (a.id < b.id ? -1 : 1),
  );

  // Split each pillar's list alternately across hemispheres.
  const hemi: Record<BrainPillar, { left: Brain3DInput[]; right: Brain3DInput[] }> = {
    marketing: { left: [], right: [] },
    growth: { left: [], right: [] },
    design: { left: [], right: [] },
  };
  for (const n of sorted) {
    const g = hemi[n.pillar];
    (g.left.length <= g.right.length ? g.left : g.right).push(n);
  }

  const out: Brain3DNode[] = [];
  (Object.keys(hemi) as BrainPillar[]).forEach((pillar) => {
    ([
      [-1, hemi[pillar].left],
      [1, hemi[pillar].right],
    ] as const).forEach(([sign, list]) => {
      const m = list.length;
      list.forEach((n, i) => {
        // Fibonacci lattice on the unit sphere…
        const y = m === 1 ? 0 : 1 - (2 * (i + 0.5)) / m;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = i * GOLDEN_ANGLE + PILLAR_THETA_OFFSET[pillar];
        const gapFrac = BRAIN_GAP / BRAIN_RX;
        // …mirrored into this hemisphere with the fissure gap enforced in
        // unit space (the radial fill below can only shrink |x|, so the
        // projection step re-enforces the gap with margin afterwards).
        const ux = sign * (gapFrac + (1 - gapFrac) * Math.abs(r * Math.cos(theta)));
        const uy = y;
        const uz = r * Math.sin(theta);
        // Radial jitter: fill the volume, not just the shell. Larger nodes
        // drift slightly outward so the heavy neurons read on the surface.
        const sizeBias = Math.min(1, n.chunks / 400);
        const radial = 0.42 + rand() * 0.58 * (0.75 + 0.25 * sizeBias);
        let x = ux * BRAIN_RX * radial;
        let y3 = uy * BRAIN_RY * radial;
        let z = uz * BRAIN_RZ * radial;
        // Project into the feasible set: inside the ellipsoid AND outside
        // the fissure. The gap push can add at most (GAP/RX)² to the
        // ellipsoid value, so a 3% gap margin survives the final
        // containment clamp with room to spare (bounded in the tests).
        const GAP_EFF = BRAIN_GAP * 1.03;
        for (let k = 0; k < 4; k++) {
          const v = (x / BRAIN_RX) ** 2 + (y3 / BRAIN_RY) ** 2 + (z / BRAIN_RZ) ** 2;
          if (v > 1) {
            const s = 0.999 / Math.sqrt(v);
            x *= s;
            y3 *= s;
            z *= s;
          }
          if (Math.abs(x) < GAP_EFF) x = sign * GAP_EFF;
        }
        const vFinal = (x / BRAIN_RX) ** 2 + (y3 / BRAIN_RY) ** 2 + (z / BRAIN_RZ) ** 2;
        if (vFinal > 1) {
          const s = 0.9999 / Math.sqrt(vFinal);
          x *= s;
          y3 *= s;
          z *= s;
        }
        out.push({
          ...n,
          x,
          y: y3,
          z,
          radius: nodeRadius3D(n.chunks, n.kind),
          hemisphere: sign,
        });
      });
    });
  });

  // Restore a deterministic global order (by id) so the scene's node array
  // is stable across renders and data refreshes.
  out.sort((a, b) => (a.id < b.id ? -1 : 1));
  return out;
}

/** True when the point sits inside the brain ellipsoid volume. */
export function insideBrain(x: number, y: number, z: number): boolean {
  const v = (x / BRAIN_RX) ** 2 + (y / BRAIN_RY) ** 2 + (z / BRAIN_RZ) ** 2;
  return v <= 1 + 1e-9;
}

// ── Filter dimming (mirrors the 2D visible() predicate) ──────────────────────

export interface Brain3DFilters {
  pillars: Set<BrainPillar>;
  tiers: Set<string>;
  q: string;
}

/** True when a node should render as a ghost (dimmed) under the filters. */
export function isDimmed3D(
  node: Pick<BrainNode, "pillar" | "tier" | "title" | "teaches" | "author">,
  f: Brain3DFilters,
): boolean {
  if (!f.pillars.has(node.pillar)) return true;
  if (!f.tiers.has(node.tier)) return true;
  if (f.q) {
    const q = f.q.toLowerCase();
    const hit =
      node.title.toLowerCase().includes(q) ||
      node.teaches.toLowerCase().includes(q) ||
      node.author.toLowerCase().includes(q);
    if (!hit) return true;
  }
  return false;
}
