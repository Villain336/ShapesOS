// ShapesOS — CAD derived bill of materials (Phase 4b).
// Spec: BUSINESS-OS-FEATURE-SPECS.md §2 slice 3 ("auto-generated BOM, cost
// estimates per revision"); REMEDIATION-PLAN Phase 4b "CAD derived BOM".
//
// What a mesh can honestly tell us, and therefore what this derives:
//   - PARTS: the bodies in the file. OBJ "o"/"g" groups and multi-solid ASCII
//     STL blocks are named parts; otherwise the triangles are split into
//     connected shells (welded on exact vertex positions).
//   - QUANTITIES: identical bodies (same triangle count, volume and sorted
//     bounding-box size, within rounding) collapse into one line with qty N.
//   - VOLUME: the signed-tetrahedra sum, ONLY for closed (watertight,
//     manifold) bodies. Open, non-manifold, zero-volume or non-finite bodies
//     get volume null with the reason recorded — never a guess, never zero.
//   - MASS: volume × the density of a material the tenant picked (a library
//     value with its source, or the tenant's own figure). No material → no
//     mass.
//   - COST: raw-material cost only, and only when the tenant enters a $/kg.
//     Everything else (fasteners, electronics, finishing) is not in a mesh
//     and stays a manual line.
// Mesh units are assumed millimetres (mesh files carry no unit metadata);
// every derived BOM records that assumption.
//
// Pure: no prisma, no Node-only APIs beyond Buffer. The store wires it to
// stored version bytes (lib/cad/pipeline-store.ts deriveBomFromGeometry).

import type { CadFormat } from "./types";
import { CadError } from "./types";
import { BOM_MATERIALS, findMaterial, type BomMaterial } from "./bom-materials";

export const DERIVE_METHOD = "mesh_bodies";
export const DERIVE_METHOD_VERSION = 1;
export const DERIVED_LINE_SOURCE = `derived:${DERIVE_METHOD}` as const;
export const DERIVE_UNIT_ASSUMPTION = "mm (assumed — mesh files carry no unit metadata)";

/** Upper bound on triangles we walk for a derivation (25 MB upload cap ≈ 500k). */
export const MAX_DERIVE_TRIANGLES = 2_000_000;
/** More shells than this is a triangle soup, not an assembly: treat as one body. */
export const MAX_DERIVED_BODIES = 500;

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------


export { BOM_MATERIALS, findMaterial, type BomMaterial };

export interface DeriveOptionsInput {
  /** A BOM_MATERIALS key. */
  materialKey?: string | null;
  /** Tenant's own material (overrides materialKey). */
  customMaterial?: { label?: unknown; densityGPerCm3?: unknown } | null;
  /** Raw-material price, USD per kg. Omitted = unit costs stay unknown. */
  costPerKgUsd?: unknown;
  notes?: unknown;
}

export interface DeriveOptions {
  material: BomMaterial | null;
  costPerKgUsd: number | null;
  notes: string | null;
}

export function validateDeriveOptions(input: DeriveOptionsInput | null | undefined): DeriveOptions {
  const o = input ?? {};
  let material: BomMaterial | null = null;
  if (o.customMaterial != null) {
    const label = String(o.customMaterial.label ?? "").trim().slice(0, 80);
    const density = Number(o.customMaterial.densityGPerCm3);
    if (!label) throw new CadError("INVALID_DERIVE_OPTIONS", "A custom material needs a name.");
    if (!Number.isFinite(density) || density <= 0 || density > 25) {
      throw new CadError("INVALID_DERIVE_OPTIONS", "Density must be a number between 0 and 25 g/cm³.");
    }
    material = {
      key: "custom",
      label,
      densityGPerCm3: density,
      category: "polymer",
      source: "Entered by the workspace (custom material)",
    };
  } else if (o.materialKey != null && String(o.materialKey).trim() !== "") {
    const found = findMaterial(String(o.materialKey).trim());
    if (!found) throw new CadError("INVALID_DERIVE_OPTIONS", `Unknown material "${String(o.materialKey).slice(0, 40)}".`);
    material = found;
  }
  let costPerKgUsd: number | null = null;
  if (o.costPerKgUsd != null && o.costPerKgUsd !== "") {
    const c = Number(o.costPerKgUsd);
    if (!Number.isFinite(c) || c < 0 || c > 100_000) {
      throw new CadError("INVALID_DERIVE_OPTIONS", "Material cost must be a non-negative USD amount per kg.");
    }
    if (!material) {
      throw new CadError("INVALID_DERIVE_OPTIONS", "Pick a material before entering a cost per kg — cost comes from mass.");
    }
    costPerKgUsd = c;
  }
  const notes = o.notes == null ? null : String(o.notes).trim().slice(0, 500) || null;
  return { material, costPerKgUsd, notes };
}

// ---------------------------------------------------------------------------
// Body extraction
// ---------------------------------------------------------------------------

export interface MeshBody {
  /** Group/solid name from the file; null for split shells. */
  name: string | null;
  /** Flat xyz triples, 9 floats per triangle, all finite. */
  positions: Float32Array;
  triangleCount: number;
}

export type BodySplit = "named_groups" | "connected_components" | "single_body";

export interface BodyExtraction {
  bodies: MeshBody[];
  split: BodySplit;
  /** Triangles dropped for non-finite (NaN/Infinity) or dangling vertices. */
  droppedTriangles: number;
  /** Finite triangles kept across all bodies. */
  keptTriangles: number;
  warnings: string[];
}

interface RawGroup {
  name: string | null;
  tris: number[];
}

function finite9(a: ArrayLike<number>): boolean {
  for (let i = 0; i < 9; i++) if (!Number.isFinite(a[i] as number)) return false;
  return true;
}

function cleanName(raw: string): string | null {
  const n = raw.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return n || null;
}

function parseBinaryStlGroups(buf: Buffer): { groups: RawGroup[]; dropped: number } {
  const count = buf.readUInt32LE(80);
  const tris: number[] = [];
  let dropped = 0;
  const t = new Array<number>(9);
  for (let i = 0, off = 84; i < count; i++, off += 50) {
    for (let k = 0; k < 9; k++) t[k] = buf.readFloatLE(off + 12 + k * 4);
    if (!finite9(t)) {
      dropped++;
      continue;
    }
    for (let k = 0; k < 9; k++) tris.push(t[k]!);
  }
  return { groups: [{ name: null, tris }], dropped };
}

function parseAsciiStlGroups(text: string): { groups: RawGroup[]; dropped: number } {
  const groups: RawGroup[] = [];
  let current: RawGroup | null = null;
  let verts: number[] = [];
  let dropped = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("solid")) {
      current = { name: cleanName(line.slice(5)), tris: [] };
      groups.push(current);
    } else if (line.startsWith("facet")) {
      verts = [];
    } else if (line.startsWith("vertex")) {
      const p = line.split(/\s+/).slice(1, 4).map(Number);
      // Keep the slot even when non-finite so the facet is judged as a whole.
      verts.push(p[0] ?? NaN, p[1] ?? NaN, p[2] ?? NaN);
    } else if (line.startsWith("endfacet")) {
      if (!current) {
        current = { name: null, tris: [] };
        groups.push(current);
      }
      if (verts.length === 9 && finite9(verts)) current.tris.push(...verts);
      else dropped++;
      verts = [];
    }
  }
  return { groups: groups.filter((g) => g.tris.length > 0), dropped };
}

function parseObjGroups(text: string): { groups: RawGroup[]; dropped: number } {
  const verts: number[] = []; // flat xyz; non-finite kept as NaN so indices stay true
  const groups: RawGroup[] = [];
  let current: RawGroup = { name: null, tris: [] };
  groups.push(current);
  let dropped = 0;
  const vertCount = () => verts.length / 3;
  const at = (ref: number): number | null => {
    const idx = ref > 0 ? ref - 1 : vertCount() + ref;
    return idx >= 0 && idx < vertCount() ? idx : null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("v ")) {
      const p = line.split(/\s+/).slice(1, 4).map(Number);
      verts.push(p[0] ?? NaN, p[1] ?? NaN, p[2] ?? NaN);
    } else if (line.startsWith("o ") || line.startsWith("g ")) {
      const name = cleanName(line.slice(2));
      current = groups.find((g) => g.name === name) ?? { name, tris: [] };
      if (!groups.includes(current)) groups.push(current);
    } else if (line.startsWith("f ")) {
      const refs = line
        .split(/\s+/)
        .slice(1)
        .map((tok) => parseInt(tok.split("/")[0]!, 10))
        .filter(Number.isInteger);
      if (refs.length < 3) {
        dropped++;
        continue;
      }
      const i0 = at(refs[0]!);
      for (let i = 1; i < refs.length - 1; i++) {
        const ia = at(refs[i]!);
        const ib = at(refs[i + 1]!);
        if (i0 == null || ia == null || ib == null) {
          dropped++;
          continue;
        }
        const t = [
          verts[i0 * 3]!, verts[i0 * 3 + 1]!, verts[i0 * 3 + 2]!,
          verts[ia * 3]!, verts[ia * 3 + 1]!, verts[ia * 3 + 2]!,
          verts[ib * 3]!, verts[ib * 3 + 1]!, verts[ib * 3 + 2]!,
        ];
        if (!finite9(t)) {
          dropped++;
          continue;
        }
        current.tris.push(...t);
      }
    }
  }
  return { groups: groups.filter((g) => g.tris.length > 0), dropped };
}

/** Exact-position vertex welding: Float32 coordinates as the identity. */
function weld(positions: Float32Array): Uint32Array {
  const ids = new Uint32Array(positions.length / 3);
  const map = new Map<string, number>();
  for (let v = 0; v < ids.length; v++) {
    const x = positions[v * 3]!;
    const y = positions[v * 3 + 1]!;
    const z = positions[v * 3 + 2]!;
    // +0 normalizes -0 so mirrored exports weld.
    const key = `${x + 0},${y + 0},${z + 0}`;
    let id = map.get(key);
    if (id === undefined) {
      id = map.size;
      map.set(key, id);
    }
    ids[v] = id;
  }
  return ids;
}

function splitComponents(positions: Float32Array): Float32Array[] {
  const triCount = positions.length / 9;
  const vid = weld(positions);
  let maxId = 0;
  for (const id of vid) if (id > maxId) maxId = id;
  const parent = new Uint32Array(maxId + 1);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]!]!;
      a = parent[a]!;
    }
    return a;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let t = 0; t < triCount; t++) {
    union(vid[t * 3]!, vid[t * 3 + 1]!);
    union(vid[t * 3]!, vid[t * 3 + 2]!);
  }
  const byRoot = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const r = find(vid[t * 3]!);
    let list = byRoot.get(r);
    if (!list) byRoot.set(r, (list = []));
    list.push(t);
  }
  const out: Float32Array[] = [];
  for (const list of byRoot.values()) {
    const arr = new Float32Array(list.length * 9);
    list.forEach((t, i) => arr.set(positions.subarray(t * 9, t * 9 + 9), i * 9));
    out.push(arr);
  }
  return out;
}

/**
 * Split a mesh upload into bodies. Null for STEP (no geometry is ever
 * extracted from STEP) and for files with no finite triangle at all.
 */
export function extractMeshBodies(buf: Buffer, format: CadFormat): BodyExtraction | null {
  if (format === "step") return null;
  let parsed: { groups: RawGroup[]; dropped: number };
  try {
    if (format === "stl") {
      const count = buf.length >= 84 ? buf.readUInt32LE(80) : 0;
      if (count > 0 && count <= 20_000_000 && 84 + count * 50 === buf.length) {
        if (count > MAX_DERIVE_TRIANGLES) return null;
        parsed = parseBinaryStlGroups(buf);
      } else {
        const text = buf.toString("utf8");
        if (!/facet\s+normal/m.test(text)) return null;
        parsed = parseAsciiStlGroups(text);
      }
    } else {
      parsed = parseObjGroups(buf.toString("utf8"));
    }
  } catch {
    return null;
  }
  const kept = parsed.groups.reduce((s, g) => s + g.tris.length / 9, 0);
  if (kept === 0) return null;
  if (kept > MAX_DERIVE_TRIANGLES) return null;

  const warnings: string[] = [];
  if (parsed.dropped > 0) {
    warnings.push(
      `${parsed.dropped} triangle(s) had non-finite (NaN/Infinity) or missing vertices and were dropped before measuring.`,
    );
  }
  const named = parsed.groups.filter((g) => g.name);
  if (parsed.groups.length >= 2 && named.length === parsed.groups.length) {
    return {
      bodies: parsed.groups.map((g) => ({
        name: g.name,
        positions: new Float32Array(g.tris),
        triangleCount: g.tris.length / 9,
      })),
      split: "named_groups",
      droppedTriangles: parsed.dropped,
      keptTriangles: kept,
      warnings,
    };
  }
  const all = new Float32Array(kept * 9);
  let off = 0;
  for (const g of parsed.groups) {
    all.set(g.tris, off);
    off += g.tris.length;
  }
  const singleName = parsed.groups.length === 1 ? parsed.groups[0]!.name : null;
  const shells = splitComponents(all);
  if (shells.length > MAX_DERIVED_BODIES) {
    warnings.push(
      `The mesh splits into ${shells.length} disconnected pieces (more than ${MAX_DERIVED_BODIES}) — it looks like a triangle soup, so it is measured as one body.`,
    );
    return {
      bodies: [{ name: singleName, positions: all, triangleCount: kept }],
      split: "single_body",
      droppedTriangles: parsed.dropped,
      keptTriangles: kept,
      warnings,
    };
  }
  return {
    bodies: shells.map((p) => ({ name: shells.length === 1 ? singleName : null, positions: p, triangleCount: p.length / 9 })),
    split: shells.length === 1 ? "single_body" : "connected_components",
    droppedTriangles: parsed.dropped,
    keptTriangles: kept,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Body measurement
// ---------------------------------------------------------------------------

export type VolumeStatus = "computed" | "open_mesh" | "zero_volume" | "non_finite";

export interface BodyMeasurement {
  triangleCount: number;
  degenerateTriangles: number;
  /** Edges used by exactly one triangle (holes). */
  boundaryEdges: number;
  /** Edges shared by three or more triangles. */
  nonManifoldEdges: number;
  closed: boolean;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  /** Bounding-box size in mesh units (mm assumed). */
  sizeMm: [number, number, number];
  surfaceAreaMm2: number;
  /** |signed volume| for closed bodies; null otherwise (see volumeStatus). */
  volumeMm3: number | null;
  volumeStatus: VolumeStatus;
  /** Closed body whose faces point inward (negative signed volume). */
  inverted: boolean;
}

function r(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function measureBody(positions: Float32Array): BodyMeasurement {
  const triCount = positions.length / 9;
  const vid = weld(positions);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const edges = new Map<number, number>();
  const EDGE_BASE = 67_108_864; // 2^26: welded ids stay below this for any accepted mesh
  let degenerate = 0;
  let area = 0;
  let volume = 0;
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const ax = positions[o]!, ay = positions[o + 1]!, az = positions[o + 2]!;
    const bx = positions[o + 3]!, by = positions[o + 4]!, bz = positions[o + 5]!;
    const cx = positions[o + 6]!, cy = positions[o + 7]!, cz = positions[o + 8]!;
    for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]] as const) {
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
    }
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const wx = cx - ax, wy = cy - ay, wz = cz - az;
    const nx = uy * wz - uz * wy;
    const ny = uz * wx - ux * wz;
    const nz = ux * wy - uy * wx;
    const triArea = Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
    const a = vid[t * 3]!, b = vid[t * 3 + 1]!, c = vid[t * 3 + 2]!;
    if (!(triArea > 1e-12) || a === b || b === c || a === c) {
      degenerate++;
      continue;
    }
    area += triArea;
    volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
      const key = p < q ? p * EDGE_BASE + q : q * EDGE_BASE + p;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  let boundary = 0;
  let nonManifold = 0;
  for (const n of edges.values()) {
    if (n === 1) boundary++;
    else if (n > 2) nonManifold++;
  }
  const real = triCount - degenerate;
  const closed = real > 0 && boundary === 0 && nonManifold === 0;
  const finiteBox = min.every(Number.isFinite) && max.every(Number.isFinite);
  const size: [number, number, number] = finiteBox
    ? [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
    : [0, 0, 0];
  const boxVolume = size[0] * size[1] * size[2];

  let volumeStatus: VolumeStatus;
  let volumeMm3: number | null = null;
  let inverted = false;
  if (!Number.isFinite(volume) || !Number.isFinite(area) || !finiteBox) {
    volumeStatus = "non_finite";
  } else if (!closed) {
    volumeStatus = "open_mesh";
  } else if (Math.abs(volume) <= Math.max(1e-9, boxVolume * 1e-9)) {
    volumeStatus = "zero_volume";
  } else {
    volumeStatus = "computed";
    inverted = volume < 0;
    volumeMm3 = Math.abs(volume);
  }
  return {
    triangleCount: triCount,
    degenerateTriangles: degenerate,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    closed,
    bboxMin: finiteBox ? [r(min[0]), r(min[1]), r(min[2])] : [0, 0, 0],
    bboxMax: finiteBox ? [r(max[0]), r(max[1]), r(max[2])] : [0, 0, 0],
    sizeMm: [r(size[0]), r(size[1]), r(size[2])],
    surfaceAreaMm2: Number.isFinite(area) ? r(area) : 0,
    volumeMm3: volumeMm3 == null ? null : r(volumeMm3),
    volumeStatus,
    inverted,
  };
}

const VOLUME_STATUS_REASON: Record<Exclude<VolumeStatus, "computed">, string> = {
  open_mesh: "the body is not closed (holes or non-manifold edges), so its volume cannot be measured",
  zero_volume: "the body encloses no volume (flat or degenerate surface)",
  non_finite: "the body's geometry is not finite",
};

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

export interface DerivedLineMeasurement extends BodyMeasurement {
  method: typeof DERIVE_METHOD;
  /** Names of the grouped bodies (named splits) or body indexes (shells). */
  bodies: string[];
  unitAssumption: string;
}

export interface DerivedBomLine {
  partName: string;
  qty: number;
  unitName: "pcs";
  materialSpec: string | null;
  unitCostUsd: number | null;
  /** Per unit. */
  volumeMm3: number | null;
  /** Per unit. */
  massG: number | null;
  source: typeof DERIVED_LINE_SOURCE;
  measurement: DerivedLineMeasurement;
}

export interface Derivation {
  method: typeof DERIVE_METHOD;
  methodVersion: number;
  unitAssumption: string;
  split: BodySplit;
  bodyCount: number;
  lineCount: number;
  keptTriangles: number;
  droppedTriangles: number;
  material: { key: string; label: string; densityGPerCm3: number; source: string } | null;
  costPerKgUsd: number | null;
  totalVolumeMm3: number | null;
  totalMassG: number | null;
  linesMissingVolume: number;
  warnings: string[];
}

export interface DerivedBom {
  lines: DerivedBomLine[];
  derivation: Derivation;
}

function baseName(name: string): string {
  const stripped = name.replace(/[\s_\-.#]*\(?\d+\)?$/, "").trim();
  return stripped || name;
}

function geometrySignature(m: BodyMeasurement): string {
  const dims = [...m.sizeMm].sort((a, b) => a - b).map((d) => d.toFixed(2));
  const vol = m.volumeMm3 == null ? "na" : m.volumeMm3.toPrecision(4);
  return `${m.triangleCount}|${vol}|${dims.join("x")}`;
}

function fmtDim(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Turn extracted bodies into BOM lines. Deterministic: same bytes + same
 * options → same lines in the same order (largest volume first, then name).
 */
export function deriveBomLines(
  extraction: BodyExtraction,
  modelName: string,
  options: DeriveOptions,
): DerivedBom {
  const label = modelName.trim() || "Part";
  const measured = extraction.bodies.map((b, i) => ({
    body: b,
    index: i + 1,
    m: measureBody(b.positions),
  }));

  // Group identical bodies. Named groups also need a matching base name, so
  // "bracket_left" and "bracket_right" stay two lines even when mirrored.
  const groups = new Map<string, typeof measured>();
  for (const x of measured) {
    const sig = geometrySignature(x.m);
    const key = x.body.name ? `${baseName(x.body.name).toLowerCase()}|${sig}` : `|${sig}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(x);
  }

  const warnings = [...extraction.warnings];
  const lines: DerivedBomLine[] = [];
  const usedNames = new Map<string, number>();
  const ordered = [...groups.values()].sort((a, b) => {
    const va = a[0]!.m.volumeMm3 ?? -1;
    const vb = b[0]!.m.volumeMm3 ?? -1;
    if (vb !== va) return vb - va;
    return (a[0]!.body.name ?? "").localeCompare(b[0]!.body.name ?? "") || a[0]!.index - b[0]!.index;
  });
  for (const list of ordered) {
    const first = list[0]!;
    const m = first.m;
    let partName: string;
    if (first.body.name) {
      partName = list.length > 1 ? baseName(first.body.name) : first.body.name;
    } else if (extraction.bodies.length === 1) {
      partName = label;
    } else {
      // Unnamed shells are named by their size, not their position in the
      // file, so the same part keeps its name across revisions (the
      // cross-version diff matches on it).
      const dims = [...m.sizeMm].sort((p, q) => q - p).map(fmtDim).join(" × ");
      partName = `${label} part ${dims} mm`;
    }
    const seen = usedNames.get(partName.toLowerCase()) ?? 0;
    usedNames.set(partName.toLowerCase(), seen + 1);
    if (seen > 0) partName = `${partName} (${seen + 1})`;
    const volumeMm3 = m.volumeMm3;
    const massG =
      volumeMm3 != null && options.material
        ? round4((volumeMm3 / 1000) * options.material.densityGPerCm3)
        : null;
    const unitCostUsd =
      massG != null && options.costPerKgUsd != null ? round4((massG / 1000) * options.costPerKgUsd) : null;
    if (m.volumeStatus !== "computed") {
      warnings.push(`"${partName}": no volume or mass — ${VOLUME_STATUS_REASON[m.volumeStatus]}.`);
    } else if (m.inverted) {
      warnings.push(`"${partName}": faces point inward (inverted normals); the volume magnitude is used.`);
    }
    lines.push({
      partName: partName.slice(0, 200),
      qty: list.length,
      unitName: "pcs",
      materialSpec: options.material?.label ?? null,
      unitCostUsd,
      volumeMm3,
      massG,
      source: DERIVED_LINE_SOURCE,
      measurement: {
        ...m,
        method: DERIVE_METHOD,
        bodies: list.map((x) => x.body.name ?? `body ${x.index}`).slice(0, 50),
        unitAssumption: DERIVE_UNIT_ASSUMPTION,
      },
    });
  }

  if (!options.material) {
    warnings.push("No material picked — volumes are listed, but mass and material cost are not computed.");
  } else if (options.material.category === "polymer") {
    warnings.push("Mass is for a fully solid part; printed parts with infill weigh less.");
  }
  if (options.costPerKgUsd != null) {
    warnings.push(
      "Unit costs are raw material only (mass × your $/kg). If your 3D-print rate card's per-cm³ rate already includes material, leave $/kg empty so the estimate doesn't count material twice.",
    );
  }
  warnings.push("Fasteners, electronics and other bought-in parts are not in a mesh — add them as manual lines.");

  const withVolume = lines.filter((l) => l.volumeMm3 != null);
  const withMass = lines.filter((l) => l.massG != null);
  const derivation: Derivation = {
    method: DERIVE_METHOD,
    methodVersion: DERIVE_METHOD_VERSION,
    unitAssumption: DERIVE_UNIT_ASSUMPTION,
    split: extraction.split,
    bodyCount: extraction.bodies.length,
    lineCount: lines.length,
    keptTriangles: extraction.keptTriangles,
    droppedTriangles: extraction.droppedTriangles,
    material: options.material
      ? {
          key: options.material.key,
          label: options.material.label,
          densityGPerCm3: options.material.densityGPerCm3,
          source: options.material.source,
        }
      : null,
    costPerKgUsd: options.costPerKgUsd,
    totalVolumeMm3: withVolume.length
      ? r(withVolume.reduce((s, l) => s + l.qty * (l.volumeMm3 as number), 0))
      : null,
    totalMassG: withMass.length ? round4(withMass.reduce((s, l) => s + l.qty * (l.massG as number), 0)) : null,
    linesMissingVolume: lines.length - withVolume.length,
    warnings,
  };
  return { lines, derivation };
}

export function stepDeriveUnavailable(): CadError {
  return new CadError(
    "DERIVE_UNAVAILABLE",
    "STEP files have no extractable mesh geometry in v1, so no BOM can be derived. Upload an STL or OBJ export of this version, or add lines by hand.",
  );
}

/**
 * Bytes → derived BOM. Throws DERIVE_UNAVAILABLE for STEP and for files with
 * no finite, measurable triangles (an empty BOM is never written).
 */
export function deriveBomFromBytes(
  bytes: Buffer,
  format: CadFormat,
  modelName: string,
  options: DeriveOptions,
): DerivedBom {
  if (format === "step") throw stepDeriveUnavailable();
  const extraction = extractMeshBodies(bytes, format);
  if (!extraction) {
    throw new CadError(
      "DERIVE_UNAVAILABLE",
      "No finite triangles could be read from this version's file, so no BOM can be derived.",
    );
  }
  return deriveBomLines(extraction, modelName, options);
}
