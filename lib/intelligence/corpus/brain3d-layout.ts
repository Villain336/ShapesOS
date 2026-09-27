// Marketr — Knowledge Brain: 3D galaxy layout.
//
// Pure, dependency-free mapping from corpus graph nodes to an organic
// knowledge-graph galaxy (Obsidian-graph style): 48 source cores as luminous
// cluster centers, each source's chunks as tiny sparkle nodes orbiting it —
// 2,678 sparkles total, all from real manifest chunk counts. No WebGL here;
// the scene component consumes plain data, so this module is unit-testable
// with node:test:
//
//   const cores    = layoutGalaxy3D(inputs);          // GalaxyCore[] with x/y/z/radius
//   const sparkles = layoutChunkSparkles(inputs, cores); // ChunkSparkle[] with x/y/z/size
//
// ORGANIZATION (the galaxy read):
// - Pillar CLUSTERS at organic, asymmetric centers (NOT rigid lobes): the
//   marketing cluster is the largest, growth and design orbit as smaller
//   clouds. Natural seeded variation — no grids, no bands.
// - HERO "solar system": the single largest source becomes a dense core with
//   a dotted orbital ring of chunk sparkles (tilted plane) plus a small
//   satellite sub-cluster (2nd-largest source of the same pillar) nearby.
// - WISPY STRANDS: a deterministic subset of sources trails part of its
//   chunks along a curved strand outward, like the tweet's wispy clusters.
// - Everything else is a gaussian chunk cloud around its source core.
//
// Invariants (asserted in __tests__/brain3d-layout.test.ts):
// - deterministic: same input → identical output (seeded PRNG)
// - sparkle count per source == its chunk count (proposed → 0)
// - hero ring sparkles sit on the tilted ring plane at ringRadius
// - hero is the max-chunk input; satellite is 2nd-largest in hero's pillar
// - core radius grows monotonically with chunk count (clamped)
// - all positions inside GALAXY_RADIUS

import type { BrainPillar, BrainNode } from "./graph";

// ── Galaxy volume ──────────────────────────────────────────────────────────

/** Bounding radius of the whole galaxy (world units). Camera frames to this. */
export const GALAXY_RADIUS = 11;

/**
 * Organic pillar cluster centers — asymmetric on purpose, like a real
 * force-directed graph. Marketing is the dominant cloud.
 */
export const PILLAR_CLUSTER_CENTER: Record<BrainPillar, readonly [number, number, number]> = {
  marketing: [-3.0, 0.8, 1.2],
  growth: [3.4, -0.6, -1.2],
  design: [0.6, -2.2, 3.2],
};

/** Cloud spread (std-ish scale) per pillar cluster. */
export const PILLAR_CLUSTER_SPREAD: Record<BrainPillar, number> = {
  marketing: 3.1,
  growth: 2.1,
  design: 2.5,
};

/** Fraction of the hero's chunks placed on the orbital ring. */
export const HERO_RING_FRACTION = 0.16;
/** Fraction of a wispy source's chunks trailing on its strand. */
export const WISPY_STRAND_FRACTION = 0.22;

const LAYOUT_SEED = 90210;
const SPARKLE_SEED = 90211;

export interface GalaxyCoreInput {
  id: string;
  pillar: BrainPillar;
  chunks: number;
  kind: BrainNode["kind"];
  tier: BrainNode["tier"];
}

export interface GalaxyCore extends GalaxyCoreInput {
  x: number;
  y: number;
  z: number;
  /** Luminous core radius in world units (∝ chunk count). */
  radius: number;
  /** True for the single largest source — the "solar system" hero. */
  hero: boolean;
  /** True for the 2nd-largest source in the hero's pillar (satellite). */
  satellite: boolean;
  /** Orbital ring radius for the hero (0 for non-heroes). */
  ringRadius: number;
  /** Tilt of the hero's ring plane, as [rotX, rotY] radians. */
  ringTilt: readonly [number, number];
  /** True when this source trails a wispy strand of chunks. */
  wispy: boolean;
  /** Unit direction of the wispy strand. */
  wispyDir: readonly [number, number, number];
}

export interface ChunkSparkle {
  sourceId: string;
  pillar: BrainPillar;
  x: number;
  y: number;
  z: number;
  /** World-unit point size (pre-attenuation). */
  size: number;
  /** True for sparkles on the hero's orbital ring. */
  ring: boolean;
  /** Staggered bloom-in delay (seconds) for the grow-in animation. */
  birth: number;
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

/** Luminous core radius for a chunk count. */
export function nodeRadius3D(chunks: number, kind: BrainNode["kind"]): number {
  if (kind === "proposed") return 0.14;
  const r = 0.16 + Math.sqrt(Math.max(chunks, 1)) * 0.038;
  return Math.min(0.85, Math.max(0.16, r));
}

/** Unit normal of the hero's tilted ring plane (from ringTilt euler). */
export function ringNormal(tilt: readonly [number, number]): [number, number, number] {
  const [rx, ry] = tilt;
  // Rotate (0,1,0) by Rx(rx) then Ry(ry):
  // Rx: (0, cos rx, sin rx) → Ry: (sin ry · sin rx, cos rx, cos ry · sin rx)
  return [Math.sin(ry) * Math.sin(rx), Math.cos(rx), Math.cos(ry) * Math.sin(rx)];
}

function unitVector(rand: () => number): [number, number, number] {
  // Uniform on the sphere via gaussian-ish rejection-free transform.
  const u = rand() * 2 - 1;
  const th = rand() * Math.PI * 2;
  const s = Math.sqrt(Math.max(0, 1 - u * u));
  return [s * Math.cos(th), s * Math.sin(th), u];
}

function gaussian(rand: () => number): number {
  return (rand() + rand() + rand() - 1.5) / 1.5; // ≈ N(0, 0.47)
}

const PILLAR_ORDER: Record<BrainPillar, number> = { marketing: 0, growth: 1, design: 2 };

/**
 * Lay source cores out as organic pillar clusters with a hero "solar
 * system". Deterministic: stable sort + one seeded PRNG stream.
 */
export function layoutGalaxy3D(inputs: GalaxyCoreInput[]): GalaxyCore[] {
  const rand = mulberry32(LAYOUT_SEED);
  const sorted = [...inputs].sort(
    (a, b) => PILLAR_ORDER[a.pillar] - PILLAR_ORDER[b.pillar] || b.chunks - a.chunks || (a.id < b.id ? -1 : 1),
  );

  const heroInput = sorted.reduce<GalaxyCoreInput | null>(
    (m, n) => (!m || n.chunks > m.chunks ? n : m),
    null,
  );
  const heroId = heroInput?.id ?? null;
  const heroPillar = heroInput?.pillar ?? "marketing";
  const satelliteId =
    sorted.filter((n) => n.pillar === heroPillar && n.id !== heroId).map((n) => n.id)[0] ?? null;

  const cores: GalaxyCore[] = sorted.map((n, i) => {
    const hero = n.id === heroId;
    const satellite = n.id === satelliteId;
    const c = PILLAR_CLUSTER_CENTER[n.pillar];
    let x: number;
    let y: number;
    let z: number;
    if (hero) {
      [x, y, z] = c;
    } else if (satellite && heroInput) {
      // Satellite sub-cluster rides near the hero.
      const d = unitVector(rand);
      const dist = 2.1 + rand() * 0.7;
      x = c[0] + d[0] * dist;
      y = c[1] + d[1] * dist;
      z = c[2] + d[2] * dist;
    } else {
      const spread = PILLAR_CLUSTER_SPREAD[n.pillar];
      x = c[0] + gaussian(rand) * spread;
      y = c[1] + gaussian(rand) * spread * 0.8;
      z = c[2] + gaussian(rand) * spread;
    }
    const radius = nodeRadius3D(n.chunks, n.kind);
    const ringRadius = hero ? radius * 4.6 + 0.9 : 0;
    const wd = unitVector(rand);
    return {
      ...n,
      x,
      y,
      z,
      radius,
      hero,
      satellite,
      ringRadius,
      ringTilt: hero ? ([0.5, 0.35] as const) : ([0, 0] as const),
      wispy: !hero && !satellite && i % 7 === 3,
      wispyDir: wd,
    };
  });

  // Clamp into the galaxy volume BEFORE repulsion (clamping shrinks
  // pairwise distances, so it must not run after separation).
  for (const c of cores) {
    const d = Math.sqrt(c.x * c.x + c.y * c.y + c.z * c.z);
    if (d > GALAXY_RADIUS) {
      const s = GALAXY_RADIUS / d;
      c.x *= s;
      c.y *= s;
      c.z *= s;
    }
  }

  // Gentle repulsion so luminous cores never overlap (deterministic passes,
  // iterated to convergence).
  for (let pass = 0; pass < 24; pass++) {
    let moved = 0;
    for (let a = 0; a < cores.length; a++) {
      for (let b = a + 1; b < cores.length; b++) {
        const A = cores[a];
        const B = cores[b];
        // The hero and its satellite are allowed to sit close (sub-cluster).
        if ((A.hero && B.satellite) || (A.satellite && B.hero)) continue;
        const dx = B.x - A.x;
        const dy = B.y - A.y;
        const dz = B.z - A.z;
        const minD = A.radius + B.radius + 0.55;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        if (d < minD) {
          moved++;
          const push = ((minD - d) / d) * 0.5;
          const px = dx * push;
          const py = dy * push;
          const pz = dz * push;
          if (!A.hero) {
            A.x -= px;
            A.y -= py;
            A.z -= pz;
          }
          if (!B.hero) {
            B.x += px;
            B.y += py;
            B.z += pz;
          }
        }
      }
    }
    if (moved === 0) break;
  }

  // Final safety clamp (rarely triggers after the pre-clamp above).
  for (const c of cores) {
    const d = Math.sqrt(c.x * c.x + c.y * c.y + c.z * c.z);
    if (d > GALAXY_RADIUS) {
      const s = GALAXY_RADIUS / d;
      c.x *= s;
      c.y *= s;
      c.z *= s;
    }
  }

  // Deterministic global order (by id) for a stable scene node array.
  cores.sort((a, b) => (a.id < b.id ? -1 : 1));
  return cores;
}

/**
 * Sparkle positions for every chunk of every source. Chunk count per
 * source is preserved exactly (proposed sources → 0). Deterministic.
 */
export function layoutChunkSparkles(inputs: GalaxyCoreInput[], cores: GalaxyCore[]): ChunkSparkle[] {
  const rand = mulberry32(SPARKLE_SEED);
  const byId = new Map(cores.map((c) => [c.id, c]));
  const out: ChunkSparkle[] = [];

  for (const n of inputs) {
    const core = byId.get(n.id);
    if (!core || n.chunks <= 0) continue;
    const total = n.chunks;
    const ringCount = core.hero ? Math.round(total * HERO_RING_FRACTION) : 0;
    const wispyCount = core.wispy ? Math.round(total * WISPY_STRAND_FRACTION) : 0;
    const [rx, ry] = core.ringTilt;

    for (let i = 0; i < total; i++) {
      let x: number;
      let y: number;
      let z: number;
      let ring = false;
      if (i < ringCount) {
        // Dotted orbital ring in the hero's tilted plane.
        ring = true;
        const a = (i / ringCount) * Math.PI * 2 + (rand() - 0.5) * 0.12;
        const px = Math.cos(a) * core.ringRadius;
        const pz = Math.sin(a) * core.ringRadius;
        // Rotate (px, 0, pz) by Rx(rx) then Ry(ry).
        const y1 = -Math.sin(rx) * pz;
        const z1 = Math.cos(rx) * pz;
        const x2 = Math.cos(ry) * px + Math.sin(ry) * z1;
        const z2 = -Math.sin(ry) * px + Math.cos(ry) * z1;
        x = core.x + x2;
        y = core.y + y1;
        z = core.z + z2;
      } else if (i < ringCount + wispyCount) {
        // Wispy strand trailing outward from the core.
        const t = rand();
        const [dx, dy, dz] = core.wispyDir;
        const along = core.radius * (2.5 + t * 7.5);
        const jit = 0.25 + t * 0.9;
        x = core.x + dx * along + gaussian(rand) * jit;
        y = core.y + dy * along + gaussian(rand) * jit;
        z = core.z + dz * along + gaussian(rand) * jit;
      } else {
        // Gaussian chunk cloud hugging the core.
        const d = unitVector(rand);
        const dist = core.radius * (1.5 + 2.8 * Math.pow(rand(), 1.6));
        x = core.x + d[0] * dist;
        y = core.y + d[1] * dist;
        z = core.z + d[2] * dist;
      }
      out.push({
        sourceId: n.id,
        pillar: n.pillar,
        x,
        y,
        z,
        size: (0.05 + rand() * 0.075) * (ring ? 1.3 : 1),
        ring,
        birth: 0.4 + rand() * 1.6,
      });
    }
  }
  return out;
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
