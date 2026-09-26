// Marketr — Knowledge Brain: 3D lobe layout.
//
// Pure, dependency-free mapping from corpus graph nodes to positions inside
// a brain-like volume (two ellipsoid hemispheres with a center gap).
// No WebGL here — the scene component consumes plain {x,y,z} data, so this
// module is unit-testable with node:test:
//
//   const placed = layoutBrain3D(nodes); // Brain3DNode[] with x/y/z/radius
//
// ORGANIZATION (the audit-center read):
// - Three LOBES by pillar along the brain's front→back axis, like cortical
//   lobes: marketing = frontal, growth = middle, design = occipital. Each
//   lobe spans both hemispheres.
// - Within a lobe, TIER BANDS run core→rim: Tier 1 inner core, Tier 2 middle
//   band, Tier 1S outer band, proposed sources on the rim.
// - Floating lobe labels anchor above each lobe (see LOBE_LABEL_ANCHORS).
//
// Invariants (all asserted in __tests__/brain3d-layout.test.ts):
// - every node respects the hemisphere gap (|x| >= GAP)
// - every node sits inside the ellipsoid volume
// - deterministic: same input → same output (seeded PRNG)
// - radius grows monotonically with chunk count
// - proposed (0-chunk) nodes get the minimum radius
// - lobe z-bands: marketing z > 0, design z < 0, growth near the middle
// - tier radial bands: mean normalized radius ordered 1 < 2 < 1S < proposed

import type { BrainPillar, BrainNode } from "./graph";

// ── Brain volume ─────────────────────────────────────────────────────────────

export const BRAIN_RX = 3.4; // ellipsoid semi-axes
export const BRAIN_RY = 2.5;
export const BRAIN_RZ = 2.7;
/** Half-width of the inter-hemisphere fissure (world units). */
export const BRAIN_GAP = 0.55;

const GOLDEN_ANGLE = 2.399963;
const LAYOUT_SEED = 1337;

/**
 * Lobe sectors: pillar → z-band on the unit sphere (front→back lobes).
 * marketing = frontal lobe, growth = middle lobe, design = occipital lobe.
 */
export const LOBE_Z_BAND: Record<BrainPillar, readonly [number, number]> = {
  marketing: [0.33, 0.9],
  growth: [-0.3, 0.3],
  design: [-0.9, -0.33],
};

/**
 * Tier radial bands: ellipsoid-normalized radius (0 = center, 1 = shell).
 * Tier 1 = inner core, Tier 2 = middle band, Tier 1S = outer band,
 * proposed = rim. The tier-1 floor (0.45) keeps the fissure gap feasible:
 * at rho >= 0.45 the gap needs |xu| <= 0.381, and 0.381² + 0.9² + 0.03 < 1.
 */
export const TIER_RADIAL_BAND: Record<string, readonly [number, number]> = {
  "1": [0.45, 0.62],
  "2": [0.62, 0.78],
  "1S": [0.78, 0.92],
  proposed: [0.9, 0.985],
};

/**
 * Floating lobe-label anchors (world units). Each label rides outside its
 * lobe's front face so the three never stack on screen: marketing and
 * design flank the brain front/back, growth crowns the top. The DOM pills
 * are projected from these anchors every frame, so each label tracks its
 * lobe as the camera orbits.
 */
export const LOBE_LABEL_ANCHORS: Record<BrainPillar, readonly [number, number, number]> = {
  marketing: [0, 0.9, BRAIN_RZ + 1.15],
  growth: [0, BRAIN_RY + 0.85, 0],
  design: [0, 0.9, -(BRAIN_RZ + 1.15)],
};

export interface Brain3DInput {
  id: string;
  pillar: BrainPillar;
  chunks: number;
  kind: BrainNode["kind"];
  tier: BrainNode["tier"];
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

/** Ellipsoid-normalized radius (0 = center, 1 = shell). */
export function normalizedRadius(x: number, y: number, z: number): number {
  return Math.sqrt((x / BRAIN_RX) ** 2 + (y / BRAIN_RY) ** 2 + (z / BRAIN_RZ) ** 2);
}

function tierBandOf(input: Brain3DInput): readonly [number, number] {
  if (input.kind === "proposed") return TIER_RADIAL_BAND.proposed;
  return TIER_RADIAL_BAND[input.tier] ?? TIER_RADIAL_BAND["2"];
}

const frac = (n: number) => n - Math.floor(n);

/**
 * Lay nodes out in the brain volume, organized into pillar lobes with tier
 * banding. Nodes are grouped by pillar; within a pillar they alternate
 * hemispheres (each half-brain gets a mix of colors, like a real brain).
 * Within a (pillar, hemisphere) group:
 *   - z spreads evenly across the pillar's lobe band (golden-ratio),
 *   - y spreads evenly across the lobe's available vertical span
 *     (golden-ratio coverage, so large beads don't all pile at one pole),
 *   - x is solved on the unit sphere with the fissure gap enforced —
 *     the tier band's radial floor keeps this feasible (see TIER_RADIAL_BAND),
 *   - the radial distance is drawn from the node's tier band (seeded).
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

  const gapFrac = BRAIN_GAP / BRAIN_RX;
  const out: Brain3DNode[] = [];
  (Object.keys(hemi) as BrainPillar[]).forEach((pillar) => {
    const [zLo, zHi] = LOBE_Z_BAND[pillar];
    ([
      [-1, hemi[pillar].left],
      [1, hemi[pillar].right],
    ] as const).forEach(([sign, list]) => {
      list.forEach((n, i) => {
        // Golden-ratio z: even coverage of the pillar's lobe band.
        const zUnit = zLo + (zHi - zLo) * frac(i * GOLDEN_ANGLE);
        // Tier band → target normalized radius (seeded).
        const [rLo, rHi] = tierBandOf(n);
        const rho = rLo + rand() * (rHi - rLo);
        // Minimum |xu| so the bead clears the fissure at this radius.
        const xuMin = Math.max(gapFrac * 1.1, (BRAIN_GAP * 1.06) / (BRAIN_RX * rho));
        // y spreads evenly across the lobe's available vertical span (the
        // tier-1 floor keeps zUnit² + xuMin² < 1 feasible — see
        // TIER_RADIAL_BAND). Golden-ratio coverage so large beads don't all
        // pile at one pole.
        const yuMax = Math.sqrt(Math.max(0.02, 1 - zUnit * zUnit - xuMin * xuMin));
        const yu = (2 * frac(i * 0.618033988749895 + 0.5) - 1) * yuMax;
        // x solves the unit sphere; the gap floor is satisfied by
        // construction (|xu| >= xuMin).
        const xu = sign * Math.sqrt(Math.max(xuMin * xuMin, 1 - zUnit * zUnit - yu * yu));
        let x = xu * BRAIN_RX * rho;
        let y3 = yu * BRAIN_RY * rho;
        let z = zUnit * BRAIN_RZ * rho;
        // Safety projection: inside the ellipsoid AND outside the fissure.
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
