// Marketr — CAD + Hardware slice 2: manufacturability checks.
// Spec: BUSINESS-OS-FEATURE-SPECS.md §2 slice 2 (wall thickness, overhangs,
// tolerance risks). Reference customer: the autonomous drone platform build
// (drone airframe parts are the model use case).
//
// Honesty contract (never bend):
// 1. Every flag cites the measurement it came from — the actual numbers,
//    the sample it was drawn from, and the threshold it was judged against.
//    A check that cannot run says so (status "unavailable") instead of
//    inventing a number.
// 2. Mesh files carry no unit metadata. All lengths are labeled with the
//    unit assumption ("mm (assumed)"); the run row records it.
// 3. STEP has no extractable mesh geometry in v1, so manufacturability is
//    "unavailable" for STEP — never a guessed analysis.
// 4. The wall-thickness check is a RAYCAST ESTIMATE over a bounded sample,
//    and says so (sample size, hit rate, confidence). It is not a metrology
//    measurement.
// 5. Process limits ingested from outside (the 45° overhang guideline, the
//    0.8 mm minimum-wall guideline) carry source pointers in MFG_REFERENCES —
//    no orphaned claims.
//
// Browser-safe: pure TS, no three.js, no prisma.

export type MfgCheckType = "wall_thickness" | "overhang" | "tolerance";

export interface MfgReference {
  rule: string;
  source: string;
  accessed: string;
}

/** Clean-sourced process limits. Every ingested rule keeps a source pointer. */
export const MFG_REFERENCES: MfgReference[] = [
  {
    rule: "FDM overhangs: ~45° from vertical is the practical support-free limit; steeper downward faces need supports or reorientation.",
    source:
      "https://forum.prusa3d.com/forum/how-do-i-print-this-printing-help/general-advice-on-adding-supports/",
    accessed: "2026-10-02",
  },
  {
    rule: "FDM minimum wall: ~0.8 mm (≈2 perimeters at a 0.4 mm nozzle) is the practical lower bound for printable walls.",
    source:
      "https://forum.prusa3d.com/forum/original-prusa-i3-mk3s-mk3-how-do-i-print-this-printing-help/is-this-printable-as-is-and-how-thin-can-i-make-the-walls/",
    accessed: "2026-10-02",
  },
];

/** Mesh files carry no unit metadata — every length is labeled with this. */
export const UNIT_ASSUMPTION = "mm (assumed — mesh files carry no unit metadata)";

/** Print axis for the overhang check. Labeled, not hidden. */
export const PRINT_AXIS: [number, number, number] = [0, 0, 1];

/** Overhang threshold: faces whose normal is within this of straight-down. */
export const OVERHANG_ANGLE_DEG = 45;
/** Minimum printable wall (FDM guideline — see MFG_REFERENCES). */
export const MIN_WALL_MM = 0.8;
/** Smallest feature edge that resolves on a typical FDM machine. */
export const MIN_FEATURE_MM = 0.2;
/** Smallest overall dimension that can slice at all. */
export const MIN_DIMENSION_MM = 0.4;

export type MfgConfidence = "high" | "medium" | "low";

export interface MfgFlagInput {
  checkType: MfgCheckType;
  severity: "info" | "warning" | "risk";
  /** The cited measurement — numbers, sample, threshold. Never invented. */
  measurement: Record<string, number | string | null>;
  message: string;
}

export interface MfgCheckOutcome {
  check: MfgCheckType;
  status: "computed" | "unavailable";
  detail: string;
}

export interface ManufacturabilityResult {
  checks: MfgCheckOutcome[];
  flags: MfgFlagInput[];
}

// ---------- vector helpers ----------

function sub(a: number[], b: number[]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function len(v: [number, number, number]): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function normalize(v: [number, number, number]): [number, number, number] {
  const l = len(v);
  return l === 0 ? [0, 0, 0] : [v[0] / l, v[1] / l, v[2] / l];
}

// ---------- uniform grid + DDA raycast (wall-thickness estimation) ----------

interface GridCell {
  min: [number, number, number];
  size: number;
  n: number; // cells per axis
  cells: number[][]; // triangle indices per cell
  positions: Float32Array;
}

function buildGrid(positions: Float32Array, triangleCount: number): GridCell {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.sqrt(
    (maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2,
  );
  // Coarser grid for huge meshes — bounded memory, honestly reported.
  const n = triangleCount > 200_000 ? 32 : 64;
  const size = Math.max(diag / n, 1e-9);
  const cells: number[][] = new Array(n * n * n);
  for (let i = 0; i < cells.length; i++) cells[i] = [];
  const idx = (ix: number, iy: number, iz: number) => ix + n * (iy + n * iz);
  for (let t = 0; t < triangleCount; t++) {
    let tMinX = Infinity, tMinY = Infinity, tMinZ = Infinity;
    let tMaxX = -Infinity, tMaxY = -Infinity, tMaxZ = -Infinity;
    for (let k = 0; k < 9; k += 3) {
      const x = positions[t * 9 + k], y = positions[t * 9 + k + 1], z = positions[t * 9 + k + 2];
      if (x < tMinX) tMinX = x; if (x > tMaxX) tMaxX = x;
      if (y < tMinY) tMinY = y; if (y > tMaxY) tMaxY = y;
      if (z < tMinZ) tMinZ = z; if (z > tMaxZ) tMaxZ = z;
    }
    const x0 = Math.max(0, Math.floor((tMinX - minX) / size));
    const x1 = Math.min(n - 1, Math.floor((tMaxX - minX) / size));
    const y0 = Math.max(0, Math.floor((tMinY - minY) / size));
    const y1 = Math.min(n - 1, Math.floor((tMaxY - minY) / size));
    const z0 = Math.max(0, Math.floor((tMinZ - minZ) / size));
    const z1 = Math.min(n - 1, Math.floor((tMaxZ - minZ) / size));
    for (let ix = x0; ix <= x1; ix++)
      for (let iy = y0; iy <= y1; iy++)
        for (let iz = z0; iz <= z1; iz++) cells[idx(ix, iy, iz)].push(t);
  }
  return { min: [minX, minY, minZ], size, n, cells, positions };
}

/** Möller–Trumbore ray/triangle intersection; null = no hit. */
function rayTriangle(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number | null {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-12 && det < 1e-12) return null;
  const invDet = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) return null;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * invDet;
  if (v < 0 || u + v > 1) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  return t > 1e-9 ? t : null;
}

/**
 * Nearest hit distance along a ray, skipping the source triangle. Walks the
 * grid with Amanatides & Woo DDA — bounded by maxDist (the bbox diagonal).
 */
function raycast(
  grid: GridCell,
  skipTriangle: number,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
): number | null {
  const { min, size, n, cells, positions } = grid;
  const idx = (ix: number, iy: number, iz: number) => ix + n * (iy + n * iz);
  let ix = Math.floor((ox - min[0]) / size);
  let iy = Math.floor((oy - min[1]) / size);
  let iz = Math.floor((oz - min[2]) / size);
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(size / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(size / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(size / dz) : Infinity;
  const boundary = (o: number, m: number, step: number) =>
    step > 0 ? m + (Math.floor((o - m) / size) + 1) * size : m + Math.floor((o - m) / size) * size;
  let tMaxX = dx !== 0 ? (boundary(ox, min[0], stepX) - ox) / dx : Infinity;
  let tMaxY = dy !== 0 ? (boundary(oy, min[1], stepY) - oy) / dy : Infinity;
  let tMaxZ = dz !== 0 ? (boundary(oz, min[2], stepZ) - oz) / dz : Infinity;
  let best: number | null = null;
  // Visit each cell at most once along the ray; stop past maxDist.
  for (let steps = 0; steps < n * 3 + 8; steps++) {
    const tCell = Math.min(tMaxX, tMaxY, tMaxZ);
    if (tCell > maxDist) break;
    if (ix >= 0 && ix < n && iy >= 0 && iy < n && iz >= 0 && iz < n) {
      for (const t of cells[idx(ix, iy, iz)]) {
        if (t === skipTriangle) continue;
        const o = t * 9;
        const hit = rayTriangle(
          ox, oy, oz, dx, dy, dz,
          positions[o], positions[o + 1], positions[o + 2],
          positions[o + 3], positions[o + 4], positions[o + 5],
          positions[o + 6], positions[o + 7], positions[o + 8],
        );
        if (hit !== null && hit <= tCell + size && (best === null || hit < best)) {
          best = hit;
        }
      }
      // A hit inside the current cell cannot be beaten by a later cell.
      if (best !== null && best <= tCell) return best;
    }
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) { ix += stepX; tMaxX += tDeltaX; }
    else if (tMaxY <= tMaxZ) { iy += stepY; tMaxY += tDeltaY; }
    else { iz += stepZ; tMaxZ += tDeltaZ; }
  }
  return best;
}

// ---------- checks ----------

const WALL_SAMPLES = 256;

function checkWallThickness(
  positions: Float32Array,
  triangleCount: number,
): { outcome: MfgCheckOutcome; flags: MfgFlagInput[] } {
  if (triangleCount < 2) {
    return {
      outcome: {
        check: "wall_thickness",
        status: "unavailable",
        detail: `Only ${triangleCount} triangle(s) — nothing to raycast against.`,
      },
      flags: [],
    };
  }
  const grid = buildGrid(positions, triangleCount);
  const diag = (() => {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2);
  })();
  const stride = Math.max(1, Math.floor(triangleCount / WALL_SAMPLES));
  const samples: number[] = [];
  let hits = 0;
  let minWall = Infinity;
  let sumWall = 0;
  for (let t = 0; t < triangleCount && samples.length < WALL_SAMPLES; t += stride) {
    const o = t * 9;
    const a = [positions[o], positions[o + 1], positions[o + 2]];
    const b = [positions[o + 3], positions[o + 4], positions[o + 5]];
    const c = [positions[o + 6], positions[o + 7], positions[o + 8]];
    const n = normalize(cross(sub(b, a), sub(c, a)));
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) continue; // degenerate
    const cx = (a[0] + b[0] + c[0]) / 3;
    const cy = (a[1] + b[1] + c[1]) / 3;
    const cz = (a[2] + b[2] + c[2]) / 3;
    // Cast inward along -n and outward along +n; the nearer hit is the
    // through-wall distance. Offset the origin to escape the source face.
    const eps = Math.max(diag * 1e-6, 1e-9);
    const dIn = raycast(grid, t, cx - n[0] * eps, cy - n[1] * eps, cz - n[2] * eps, -n[0], -n[1], -n[2], diag);
    const dOut = raycast(grid, t, cx + n[0] * eps, cy + n[1] * eps, cz + n[2] * eps, n[0], n[1], n[2], diag);
    const d = dIn === null ? dOut : dOut === null ? dIn : Math.min(dIn, dOut);
    samples.push(d ?? -1);
    if (d !== null) {
      hits++;
      sumWall += d;
      if (d < minWall) minWall = d;
    }
  }
  const hitRate = samples.length ? hits / samples.length : 0;
  const confidence: MfgConfidence =
    samples.length >= 200 && hitRate >= 0.8 ? "high" : samples.length >= 50 ? "medium" : "low";
  const detail =
    `Raycast estimate over ${samples.length} sampled faces of ${triangleCount} ` +
    `(${hitRate >= 1 ? "100" : (hitRate * 100).toFixed(0)}% of rays hit the far wall; ` +
    `confidence ${confidence}). Min ${Number.isFinite(minWall) ? minWall.toFixed(2) : "—"} mm, ` +
    `mean ${(hits ? sumWall / hits : 0).toFixed(2)} mm. Units: ${UNIT_ASSUMPTION}.`;
  const flags: MfgFlagInput[] = [];
  if (Number.isFinite(minWall) && minWall < MIN_WALL_MM) {
    flags.push({
      checkType: "wall_thickness",
      severity: minWall < MIN_WALL_MM / 2 ? "risk" : "warning",
      measurement: {
        minWallMm: Math.round(minWall * 100) / 100,
        meanWallMm: Math.round(((hits ? sumWall / hits : 0) * 100)) / 100,
        thresholdMm: MIN_WALL_MM,
        sampledFaces: samples.length,
        totalFaces: triangleCount,
        hitRate: Math.round(hitRate * 100) / 100,
        confidence,
        unit: UNIT_ASSUMPTION,
      },
      message:
        `Thinnest sampled wall ≈ ${minWall.toFixed(2)} mm — below the ${MIN_WALL_MM} mm ` +
        `FDM minimum-wall guideline. This region may fail to slice or print fragile.`,
    });
  }
  return { outcome: { check: "wall_thickness", status: "computed", detail }, flags };
}

function checkOverhang(
  positions: Float32Array,
  triangleCount: number,
): { outcome: MfgCheckOutcome; flags: MfgFlagInput[] } {
  const cosLimit = Math.cos((OVERHANG_ANGLE_DEG * Math.PI) / 180);
  // The bbox floor: faces sitting on the build plate are not overhangs.
  let zMin = Infinity, zMax = -Infinity;
  for (let i = 2; i < positions.length; i += 3) {
    if (positions[i] < zMin) zMin = positions[i];
    if (positions[i] > zMax) zMax = positions[i];
  }
  const plateEps = Math.max((zMax - zMin) * 1e-6, 1e-9);
  let flaggedTris = 0;
  let flaggedArea = 0;
  let totalArea = 0;
  let maxAngleDeg = 0;
  let plateFaces = 0;
  for (let t = 0; t < triangleCount; t++) {
    const o = t * 9;
    const a = [positions[o], positions[o + 1], positions[o + 2]];
    const b = [positions[o + 3], positions[o + 4], positions[o + 5]];
    const c = [positions[o + 6], positions[o + 7], positions[o + 8]];
    const n = normalize(cross(sub(b, a), sub(c, a)));
    const area = len(cross(sub(b, a), sub(c, a))) / 2;
    totalArea += area;
    const centroidZ = (a[2] + b[2] + c[2]) / 3;
    // Downward-facing faces steeper than 45° from vertical need support —
    // except faces resting on the build plate.
    const nz = n[2];
    if (nz < -cosLimit) {
      if (centroidZ - zMin <= plateEps) {
        plateFaces++;
        continue;
      }
      flaggedTris++;
      flaggedArea += area;
      // Face angle from vertical: a horizontal face is 90° from vertical.
      const angleDeg = (Math.asin(Math.min(1, Math.abs(nz))) * 180) / Math.PI;
      if (angleDeg > maxAngleDeg) maxAngleDeg = angleDeg;
    }
  }
  const areaFrac = totalArea > 0 ? flaggedArea / totalArea : 0;
  const detail =
    `${flaggedTris} of ${triangleCount} faces (${(areaFrac * 100).toFixed(1)}% of surface area) ` +
    `face downward steeper than ${OVERHANG_ANGLE_DEG}° from vertical, excluding ` +
    `${plateFaces} face(s) resting on the build plate. Print axis: +Z. ` +
    `Steepest flagged face: ${maxAngleDeg.toFixed(1)}° from vertical.`;
  const flags: MfgFlagInput[] = [];
  if (flaggedTris > 0) {
    flags.push({
      checkType: "overhang",
      severity: areaFrac > 0.1 ? "risk" : areaFrac > 0.02 ? "warning" : "info",
      measurement: {
        flaggedFaces: flaggedTris,
        totalFaces: triangleCount,
        flaggedAreaFraction: Math.round(areaFrac * 1000) / 1000,
        steepestFaceDeg: Math.round(maxAngleDeg * 10) / 10,
        angleThresholdDeg: OVERHANG_ANGLE_DEG,
        printAxis: "Z",
      },
      message:
        `${flaggedTris} faces (${(areaFrac * 100).toFixed(1)}% of area) overhang steeper than ` +
        `${OVERHANG_ANGLE_DEG}° — they need supports or a reorientation of the part on the build plate.`,
    });
  }
  return { outcome: { check: "overhang", status: "computed", detail }, flags };
}

function checkTolerance(
  positions: Float32Array,
  triangleCount: number,
): { outcome: MfgCheckOutcome; flags: MfgFlagInput[] } {
  // Min edge length over a bounded sample + smallest bbox dimension.
  const stride = Math.max(1, Math.floor(triangleCount / 2000));
  let minEdge = Infinity;
  let minDim = Infinity;
  let gMinX = Infinity, gMinY = Infinity, gMinZ = Infinity;
  let gMaxX = -Infinity, gMaxY = -Infinity, gMaxZ = -Infinity;
  for (let t = 0; t < triangleCount; t += stride) {
    const o = t * 9;
    for (let k = 0; k < 9; k += 3) {
      const x = positions[o + k], y = positions[o + k + 1], z = positions[o + k + 2];
      if (x < gMinX) gMinX = x; if (x > gMaxX) gMaxX = x;
      if (y < gMinY) gMinY = y; if (y > gMaxY) gMaxY = y;
      if (z < gMinZ) gMinZ = z; if (z > gMaxZ) gMaxZ = z;
    }
    const d = (p: number, q: number) => {
      const dx = positions[o + p * 3] - positions[o + q * 3];
      const dy = positions[o + p * 3 + 1] - positions[o + q * 3 + 1];
      const dz = positions[o + p * 3 + 2] - positions[o + q * 3 + 2];
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    };
    minEdge = Math.min(minEdge, d(0, 1), d(1, 2), d(2, 0));
  }
  minDim = Math.min(gMaxX - gMinX, gMaxY - gMinY, gMaxZ - gMinZ);
  const sampled = Math.ceil(triangleCount / stride);
  const flags: MfgFlagInput[] = [];
  if (Number.isFinite(minEdge) && minEdge < MIN_FEATURE_MM) {
    flags.push({
      checkType: "tolerance",
      severity: "warning",
      measurement: {
        smallestEdgeMm: Math.round(minEdge * 1000) / 1000,
        thresholdMm: MIN_FEATURE_MM,
        sampledFaces: sampled,
        totalFaces: triangleCount,
        unit: UNIT_ASSUMPTION,
      },
      message:
        `Smallest feature edge ≈ ${minEdge.toFixed(3)} mm — below the ${MIN_FEATURE_MM} mm ` +
        `typical FDM resolution. This detail may not resolve in the print.`,
    });
  }
  if (Number.isFinite(minDim) && minDim < MIN_DIMENSION_MM) {
    flags.push({
      checkType: "tolerance",
      severity: "risk",
      measurement: {
        smallestDimensionMm: Math.round(minDim * 1000) / 1000,
        thresholdMm: MIN_DIMENSION_MM,
        unit: UNIT_ASSUMPTION,
      },
      message:
        `Smallest overall dimension ≈ ${minDim.toFixed(3)} mm — below the ${MIN_DIMENSION_MM} mm ` +
        `slicing floor. The part (or this axis of it) may not slice at all.`,
    });
  }
  const detail =
    `Smallest sampled feature edge ${Number.isFinite(minEdge) ? minEdge.toFixed(3) : "—"} mm ` +
    `(sampled ${sampled} of ${triangleCount} faces); smallest overall dimension ` +
    `${Number.isFinite(minDim) ? minDim.toFixed(3) : "—"} mm. Units: ${UNIT_ASSUMPTION}.`;
  return { outcome: { check: "tolerance", status: "computed", detail }, flags };
}

/**
 * Run the deterministic manufacturability checks over REAL extracted mesh
 * triangles. Every flag cites its measurement; a check that cannot run is
 * reported "unavailable" — numbers are never invented.
 */
export function runManufacturabilityChecks(
  positions: Float32Array,
  triangleCount: number,
): ManufacturabilityResult {
  if (!positions || triangleCount <= 0 || positions.length < triangleCount * 9) {
    return {
      checks: [
        { check: "wall_thickness", status: "unavailable", detail: "No mesh triangles were extracted — analysis cannot run." },
        { check: "overhang", status: "unavailable", detail: "No mesh triangles were extracted — analysis cannot run." },
        { check: "tolerance", status: "unavailable", detail: "No mesh triangles were extracted — analysis cannot run." },
      ],
      flags: [],
    };
  }
  // Never report computed results from NaN/Infinity geometry (the extractor
  // drops such triangles; this guards any other caller).
  for (let i = 0; i < triangleCount * 9; i++) {
    if (!Number.isFinite(positions[i])) {
      const detail = "The mesh has non-finite (NaN/Infinity) coordinates — analysis cannot run.";
      return {
        checks: [
          { check: "wall_thickness", status: "unavailable", detail },
          { check: "overhang", status: "unavailable", detail },
          { check: "tolerance", status: "unavailable", detail },
        ],
        flags: [],
      };
    }
  }
  const wall = checkWallThickness(positions, triangleCount);
  const over = checkOverhang(positions, triangleCount);
  const tol = checkTolerance(positions, triangleCount);
  return {
    checks: [wall.outcome, over.outcome, tol.outcome],
    flags: [...wall.flags, ...over.flags, ...tol.flags],
  };
}
