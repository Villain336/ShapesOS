// Marketr — Knowledge Brain: morph-form geometry for the sparkle field.
//
// The six shape builders (sphere, torus, helix, knot, cube, wave) plus the
// normalize + bearing-sort helpers are ported from the
// `particle-shape-morph` registry component (pixel-perfect.space), which Tico
// chose for the Brain's particle layer. There they drive a 2D canvas; here
// they generate morph *targets* for the Brain's existing three.js sparkle
// shader (see BrainScene3D.tsx), so the 3D galaxy, clusters, tour and zoom
// behavior are untouched — only the particle field gains shape-morphing.

export type MorphShapeName =
  | "sphere"
  | "torus"
  | "helix"
  | "knot"
  | "cube"
  | "wave";

export const MORPH_SHAPE_LABELS: Record<MorphShapeName, string> = {
  sphere: "Lattice sphere",
  torus: "Torus",
  helix: "Double helix",
  knot: "Trefoil knot",
  cube: "Cube lattice",
  wave: "Wave grid",
};

const TAU = Math.PI * 2;
/** Turn by this much between successive points and they never line up into rows. */
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

function buildSphere(out: Float32Array, n: number) {
  // Golden-angle (Fibonacci) sphere: even coverage, no crowding at the poles.
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * i + 1) / n;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * GOLDEN;
    out[i * 3] = Math.cos(a) * r;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(a) * r;
  }
}

function buildTorus(out: Float32Array, n: number) {
  const R = 0.79;
  const r = 0.2;
  const nv = Math.max(6, Math.round(Math.sqrt((n * r) / R)));
  const nu = Math.max(8, Math.floor(n / nv));
  const grid = nu * nv;
  for (let i = 0; i < n; i++) {
    let u: number;
    let v: number;
    if (i < grid) {
      const a = Math.floor(i / nv);
      u = (a / nu) * TAU;
      v = ((i - a * nv + (a % 2) * 0.5) / nv) * TAU;
    } else {
      u = ((i - grid) / (n - grid)) * TAU;
      v = 0;
    }
    const rad = R + r * Math.cos(v);
    out[i * 3] = rad * Math.cos(u);
    out[i * 3 + 1] = r * Math.sin(v);
    out[i * 3 + 2] = rad * Math.sin(u);
  }
}

function buildHelix(out: Float32Array, n: number) {
  const TURNS = 2.2;
  const RAD = 0.62;
  const H = 1;
  const BARS = 13;
  const strand = Math.floor(n * 0.34);
  const rungs = n - strand * 2;
  const perBar = Math.max(1, Math.floor(rungs / BARS));

  const place = (i: number, t: number, phase: number, mix: number) => {
    const y = -H + 2 * H * t;
    const a = t * TURNS * TAU + phase;
    const x = RAD * Math.cos(a);
    const z = RAD * Math.sin(a);
    out[i * 3] = x - 2 * x * mix;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z - 2 * z * mix;
  };

  for (let i = 0; i < strand; i++) place(i, i / (strand - 1 || 1), 0, 0);
  for (let i = 0; i < strand; i++) place(strand + i, i / (strand - 1 || 1), 0, 1);
  for (let j = 0; j < rungs; j++) {
    const bar = Math.min(BARS - 1, Math.floor(j / perBar));
    const inner = j - bar * perBar;
    place(2 * strand + j, (bar + 0.5) / BARS, 0, (inner + 1) / (perBar + 1));
  }
}

function buildKnot(out: Float32Array, n: number) {
  const TUBE = 0.34;
  /** The (2,3) torus knot: three lobes, each passing through the next. */
  const centre = (t: number, p: Float32Array) => {
    p[0] = Math.sin(t) + 2 * Math.sin(2 * t);
    p[1] = Math.cos(t) - 2 * Math.cos(2 * t);
    p[2] = -Math.sin(3 * t);
  };
  const ring = Math.max(5, Math.round(Math.sqrt(n / 7)));
  const stations = Math.max(8, Math.ceil(n / ring));
  const here = new Float32Array(3);
  const next = new Float32Array(3);
  const tan = new Float32Array(3);
  const nrm = new Float32Array(3);
  const bin = new Float32Array(3);
  let station = -1;
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i / ring);
    if (a !== station) {
      station = a;
      const t = (a / stations) * TAU;
      centre(t, here);
      centre(t + 1e-3, next);
      let len = Math.hypot(next[0] - here[0], next[1] - here[1], next[2] - here[2]) || 1;
      for (let k = 0; k < 3; k++) tan[k] = (next[k] - here[k]) / len;
      const up = Math.abs(tan[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      nrm[0] = tan[1] * up[2] - tan[2] * up[1];
      nrm[1] = tan[2] * up[0] - tan[0] * up[2];
      nrm[2] = tan[0] * up[1] - tan[1] * up[0];
      len = Math.hypot(nrm[0], nrm[1], nrm[2]) || 1;
      for (let k = 0; k < 3; k++) nrm[k] /= len;
      bin[0] = tan[1] * nrm[2] - tan[2] * nrm[1];
      bin[1] = tan[2] * nrm[0] - tan[0] * nrm[2];
      bin[2] = tan[0] * nrm[1] - tan[1] * nrm[0];
    }
    const v = ((i - a * ring + (a % 2) * 0.5) / ring) * TAU;
    const cs = Math.cos(v) * TUBE;
    const sn = Math.sin(v) * TUBE;
    for (let k = 0; k < 3; k++) out[i * 3 + k] = here[k] + nrm[k] * cs + bin[k] * sn;
  }
}

function buildCube(out: Float32Array, n: number) {
  const faceBudget = Math.round(n * 0.82);
  const side = Math.max(2, Math.round(Math.sqrt(faceBudget / 6)));
  const grid = side * side * 6;
  const edgePoints = n - grid;
  const write = (i: number, p: number[]) => {
    out[i * 3] = p[0];
    out[i * 3 + 1] = p[1];
    out[i * 3 + 2] = p[2];
  };
  for (let i = 0; i < grid; i++) {
    const face = Math.floor(i / (side * side));
    const cell = i - face * side * side;
    const u = ((Math.floor(cell / side) + 0.5) / side) * 2 - 1;
    const v = (((cell % side) + 0.5) / side) * 2 - 1;
    const axis = face >> 1;
    const s = face & 1 ? -1 : 1;
    write(i, axis === 0 ? [s, u, v] : axis === 1 ? [u, s, v] : [u, v, s]);
  }
  const perEdge = Math.max(1, Math.ceil(edgePoints / 12));
  for (let j = 0; j < edgePoints; j++) {
    const e = j % 12;
    const t = ((Math.floor(j / 12) + 0.5) / perEdge) * 2 - 1;
    const axis = Math.floor(e / 4);
    const a = e & 1 ? -1 : 1;
    const b = e & 2 ? -1 : 1;
    write(
      grid + j,
      axis === 0 ? [t, a, b] : axis === 1 ? [a, t, b] : [a, b, t],
    );
  }
}

function buildWave(out: Float32Array, n: number) {
  const side = Math.max(2, Math.floor(Math.sqrt(n)));
  const grid = side * side;
  const height = (u: number, v: number) =>
    0.34 * Math.sin(u * Math.PI * 1.5 + v * Math.PI * 0.55) +
    0.12 * Math.sin(v * Math.PI * 2.2);
  for (let i = 0; i < n; i++) {
    let u: number;
    let v: number;
    if (i < grid) {
      u = ((Math.floor(i / side) + 0.5) / side) * 2 - 1;
      v = (((i % side) + 0.5) / side) * 2 - 1;
    } else {
      const t = ((i - grid) / (n - grid)) * 4;
      const leg = Math.floor(t);
      const s = (t - leg) * 2 - 1;
      u = leg === 0 ? s : leg === 1 ? 1 : leg === 2 ? -s : -1;
      v = leg === 0 ? -1 : leg === 1 ? s : leg === 2 ? -s : -1;
    }
    out[i * 3] = u;
    out[i * 3 + 1] = height(u, v);
    out[i * 3 + 2] = v;
  }
}

const BUILDERS: Record<MorphShapeName, (out: Float32Array, n: number) => void> = {
  sphere: buildSphere,
  torus: buildTorus,
  helix: buildHelix,
  knot: buildKnot,
  cube: buildCube,
  wave: buildWave,
};

export const MORPH_SHAPES: MorphShapeName[] = [
  "sphere",
  "torus",
  "helix",
  "knot",
  "cube",
  "wave",
];

/** Centre a form and fit its bounding box into ±0.95, so every shape frames alike. */
function normalize(p: Float32Array, n: number) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n * 3; i++) {
    const a = i % 3;
    if (p[i] < lo[a]) lo[a] = p[i];
    if (p[i] > hi[a]) hi[a] = p[i];
  }
  const mid = [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2);
  const half = Math.max(...[0, 1, 2].map((a) => (hi[a] - lo[a]) / 2), 1e-6);
  const k = 0.95 / half;
  for (let i = 0; i < n * 3; i++) p[i] = (p[i] - mid[i % 3]) * k;
}

/**
 * Reorder a form so index 0..n sweeps once around the vertical axis, rising
 * within each sector. Every shape shares that order, so a sparkle lands near
 * the bearing it left from and the morph reads as one turning field rather
 * than a swarm shuffling at random.
 */
function sortByBearing(p: Float32Array, n: number) {
  const SECTORS = 48;
  const order = Array.from({ length: n }, (_, i) => i);
  const key = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const bearing = (Math.atan2(p[i * 3 + 2], p[i * 3]) + Math.PI) / TAU;
    key[i] = Math.floor(bearing * SECTORS) * 4 + (p[i * 3 + 1] + 1);
  }
  order.sort((a, b) => key[a] - key[b]);
  const sorted = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    sorted[i * 3] = p[order[i] * 3];
    sorted[i * 3 + 1] = p[order[i] * 3 + 1];
    sorted[i * 3 + 2] = p[order[i] * 3 + 2];
  }
  return sorted;
}

/**
 * Build all six morph target fields for `count` particles, scaled to `scale`
 * world units and centred on `center`. Returns one Float32Array per shape,
 * index-aligned with the sparkle array so sparkle `i` always flies to
 * `forms[shape][i*3 .. i*3+2]`.
 */
export function buildMorphForms(
  count: number,
  scale: number,
  center: readonly [number, number, number],
): Float32Array[] {
  return MORPH_SHAPES.map((name) => {
    const data = new Float32Array(count * 3);
    BUILDERS[name](data, count);
    normalize(data, count);
    const sorted = sortByBearing(data, count);
    for (let i = 0; i < count * 3; i++) {
      sorted[i] = sorted[i] * scale + center[i % 3];
    }
    return sorted;
  });
}
