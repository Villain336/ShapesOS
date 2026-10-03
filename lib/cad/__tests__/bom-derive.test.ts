// ShapesOS — CAD derived BOM (Phase 4b): pure derivation, rollups across
// revisions, CSV export escaping. No database.
// Run: npx tsx --test lib/cad/__tests__/bom-derive.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BOM_MATERIALS,
  deriveBomFromBytes,
  extractMeshBodies,
  findMaterial,
  measureBody,
  validateDeriveOptions,
  DERIVED_LINE_SOURCE,
} from "../bom-derive";
import {
  bomCsvRows,
  compareBomRollups,
  computeBomRollup,
  DERIVED_METHODS,
  validateBomLineInput,
} from "../prototype";
import { csvRow } from "../../csv";
import { CadError } from "../types";

type Tri = number[];

/** 12 outward-wound triangles of an axis-aligned box. */
function box(size: number, [ox, oy, oz]: [number, number, number] = [0, 0, 0], h = size): Tri[] {
  const unit: Tri[] = [
    [0, 0, 0, 0, 1, 0, 1, 1, 0], [0, 0, 0, 1, 1, 0, 1, 0, 0],
    [0, 0, 1, 1, 0, 1, 1, 1, 1], [0, 0, 1, 1, 1, 1, 0, 1, 1],
    [0, 0, 0, 1, 0, 0, 1, 0, 1], [0, 0, 0, 1, 0, 1, 0, 0, 1],
    [0, 1, 0, 0, 1, 1, 1, 1, 1], [0, 1, 0, 1, 1, 1, 1, 1, 0],
    [0, 0, 0, 0, 0, 1, 0, 1, 1], [0, 0, 0, 0, 1, 1, 0, 1, 0],
    [1, 0, 0, 1, 1, 0, 1, 1, 1], [1, 0, 0, 1, 1, 1, 1, 0, 1],
  ];
  return unit.map((t) => t.map((v, i) => (i % 3 === 0 ? ox + v * size : i % 3 === 1 ? oy + v * size : oz + v * h)));
}

function binaryStl(tris: Tri[]): Buffer {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => t.forEach((v, k) => buf.writeFloatLE(v, 84 + i * 50 + 12 + k * 4)));
  return buf;
}

function asciiStl(solids: { name: string; tris: Tri[] }[]): Buffer {
  const out: string[] = [];
  for (const s of solids) {
    out.push(`solid ${s.name}`);
    for (const t of s.tris) {
      out.push("  facet normal 0 0 0", "    outer loop");
      for (let v = 0; v < 3; v++) out.push(`      vertex ${t[v * 3]} ${t[v * 3 + 1]} ${t[v * 3 + 2]}`);
      out.push("    endloop", "  endfacet");
    }
    out.push(`endsolid ${s.name}`);
  }
  return Buffer.from(out.join("\n"));
}

function obj(groups: { name: string; tris: Tri[] }[], extraVerts = ""): Buffer {
  const lines: string[] = [extraVerts];
  let n = extraVerts ? extraVerts.split("\n").filter((l) => l.startsWith("v ")).length : 0;
  for (const g of groups) {
    lines.push(`o ${g.name}`);
    for (const t of g.tris) {
      for (let v = 0; v < 3; v++) lines.push(`v ${t[v * 3]} ${t[v * 3 + 1]} ${t[v * 3 + 2]}`);
      lines.push(`f ${n + 1} ${n + 2} ${n + 3}`);
      n += 3;
    }
  }
  return Buffer.from(lines.join("\n"));
}

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof CadError ? e.code : `non-cad:${String(e)}`;
  }
}

/** Every number anywhere in the value is finite (no NaN/Infinity leaks). */
function allFinite(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(allFinite);
  if (v && typeof v === "object") return Object.values(v).every(allFinite);
  return true;
}

const NO_MATERIAL = validateDeriveOptions({});
const PLA = validateDeriveOptions({ materialKey: "pla", costPerKgUsd: 20 });

describe("derived BOM — bodies, quantities, volume, mass", () => {
  it("one closed cube → one line, volume measured, mass needs a material", () => {
    const { lines, derivation } = deriveBomFromBytes(binaryStl(box(10)), "stl", "Motor mount", NO_MATERIAL);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.partName, "Motor mount");
    assert.equal(lines[0]!.qty, 1);
    assert.equal(lines[0]!.source, DERIVED_LINE_SOURCE);
    assert.equal(lines[0]!.volumeMm3, 1000);
    assert.equal(lines[0]!.massG, null);
    assert.equal(lines[0]!.unitCostUsd, null);
    assert.equal(lines[0]!.measurement.closed, true);
    assert.deepEqual(lines[0]!.measurement.sizeMm, [10, 10, 10]);
    assert.equal(derivation.split, "single_body");
    assert.equal(derivation.totalMassG, null);
    assert.ok(derivation.warnings.some((w) => /No material picked/.test(w)));
    assert.match(derivation.unitAssumption, /mm \(assumed/);
  });

  it("identical shells collapse into a quantity; largest part first; mass + material cost", () => {
    const tris = [...box(10, [0, 0, 0]), ...box(10, [50, 0, 0]), ...box(20, [100, 0, 0])];
    const { lines, derivation } = deriveBomFromBytes(binaryStl(tris), "stl", "Airframe", PLA);
    assert.equal(derivation.split, "connected_components");
    assert.equal(derivation.bodyCount, 3);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.qty, 1);
    assert.equal(lines[0]!.volumeMm3, 8000);
    assert.equal(lines[0]!.massG, 9.92); // 8 cm³ × 1.24 g/cm³
    assert.equal(lines[1]!.qty, 2);
    assert.equal(lines[1]!.massG, 1.24);
    assert.equal(lines[1]!.unitCostUsd, 0.0248); // 1.24 g × $20/kg
    assert.equal(lines[0]!.materialSpec, "PLA");
    // Unnamed shells are named by size (stable across revisions), not file order.
    assert.deepEqual(lines.map((l) => l.partName), ["Airframe part 20 × 20 × 20 mm", "Airframe part 10 × 10 × 10 mm"]);
    assert.equal(derivation.totalVolumeMm3, 10000);
    assert.equal(derivation.totalMassG, 12.4);
    assert.equal(derivation.material?.source, findMaterial("pla")!.source);
    assert.ok(derivation.warnings.some((w) => /count material twice/.test(w)));
  });

  it("an open mesh reports no volume and says why — never zero", () => {
    const { lines, derivation } = deriveBomFromBytes(binaryStl(box(10).slice(1)), "stl", "Shell", PLA);
    assert.equal(lines[0]!.volumeMm3, null);
    assert.equal(lines[0]!.massG, null);
    assert.equal(lines[0]!.unitCostUsd, null);
    assert.equal(lines[0]!.measurement.volumeStatus, "open_mesh");
    assert.ok(lines[0]!.measurement.boundaryEdges > 0);
    assert.equal(derivation.linesMissingVolume, 1);
    assert.equal(derivation.totalVolumeMm3, null);
    assert.ok(derivation.warnings.some((w) => /not closed/.test(w)));
  });

  it("NaN / Infinity triangles are dropped and counted; the rest is measured with finite numbers", () => {
    const tris = [...box(10), [NaN, 0, 0, 1, 1, 1, 2, 2, 2], [0, 0, 0, Infinity, 0, 0, 0, 1, 0]];
    const { lines, derivation } = deriveBomFromBytes(binaryStl(tris), "stl", "Part", PLA);
    assert.equal(derivation.droppedTriangles, 2);
    assert.equal(derivation.keptTriangles, 12);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.volumeMm3, 1000);
    assert.ok(allFinite(lines) && allFinite(derivation));
    assert.ok(derivation.warnings.some((w) => /non-finite/.test(w)));
  });

  it("an all-NaN file or a STEP file derives nothing (DERIVE_UNAVAILABLE)", () => {
    const nan = binaryStl([new Array(9).fill(NaN), new Array(9).fill(Infinity)]);
    assert.equal(extractMeshBodies(nan, "stl"), null);
    assert.equal(code(() => deriveBomFromBytes(nan, "stl", "X", PLA)), "DERIVE_UNAVAILABLE");
    const step = Buffer.from("ISO-10303-21;\nHEADER;\nENDSEC;");
    assert.equal(code(() => deriveBomFromBytes(step, "step", "X", PLA)), "DERIVE_UNAVAILABLE");
    assert.equal(code(() => deriveBomFromBytes(Buffer.from("garbage"), "obj", "X", PLA)), "DERIVE_UNAVAILABLE");
  });

  it("inverted normals: magnitude used, flagged", () => {
    const inverted = box(10).map((t) => [...t.slice(0, 3), ...t.slice(6, 9), ...t.slice(3, 6)]);
    const { lines, derivation } = deriveBomFromBytes(binaryStl(inverted), "stl", "Flip", NO_MATERIAL);
    assert.equal(lines[0]!.volumeMm3, 1000);
    assert.equal(lines[0]!.measurement.inverted, true);
    assert.ok(derivation.warnings.some((w) => /inverted normals/.test(w)));
  });

  it("degenerate geometry: a closed zero-thickness sheet and zero-area triangles", () => {
    // Two triangles back to back: every edge shared twice (closed), no volume.
    const sheet = [[0, 0, 0, 10, 0, 0, 0, 10, 0], [0, 0, 0, 0, 10, 0, 10, 0, 0]];
    const m = measureBody(new Float32Array(sheet.flat()));
    assert.equal(m.closed, true);
    assert.equal(m.volumeStatus, "zero_volume");
    assert.equal(m.volumeMm3, null);
    // Only zero-area triangles: nothing real to measure.
    const dots = measureBody(new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]));
    assert.equal(dots.degenerateTriangles, 1);
    assert.equal(dots.closed, false);
    assert.equal(dots.volumeMm3, null);
    // A cube plus a stray zero-area triangle still measures.
    const withDot = measureBody(new Float32Array([...box(10).flat(), 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    assert.equal(withDot.degenerateTriangles, 1);
    assert.equal(withDot.volumeMm3, 1000);
  });

  it("OBJ named groups are parts; numbered copies of one shape collapse to a quantity", () => {
    const buf = obj([
      { name: "frame", tris: box(30) },
      { name: "screw_1", tris: box(2, [40, 0, 0]) },
      { name: "screw_2", tris: box(2, [50, 0, 0]) },
    ]);
    const { lines, derivation } = deriveBomFromBytes(buf, "obj", "Drone", NO_MATERIAL);
    assert.equal(derivation.split, "named_groups");
    assert.deepEqual(
      lines.map((l) => [l.partName, l.qty]),
      [["frame", 1], ["screw", 2]],
    );
    assert.deepEqual(lines[1]!.measurement.bodies, ["screw_1", "screw_2"]);
  });

  it("OBJ: a non-finite vertex drops only the faces using it (later indices stay true)", () => {
    const buf = obj([{ name: "a", tris: box(10) }, { name: "b", tris: box(5, [20, 0, 0]) }], "v 1e999 0 0\nv 0 0 0\nv 1 0 0\nf 1 2 3");
    const ex = extractMeshBodies(buf, "obj");
    assert.ok(ex);
    assert.equal(ex.droppedTriangles, 1);
    const { lines } = deriveBomFromBytes(buf, "obj", "X", NO_MATERIAL);
    assert.deepEqual(lines.map((l) => l.volumeMm3), [1000, 125]);
  });

  it("ASCII STL with several solids → named parts", () => {
    const buf = asciiStl([
      { name: "arm", tris: box(10, [0, 0, 0], 40) },
      { name: "hub", tris: box(20, [30, 0, 0]) },
    ]);
    const { lines, derivation } = deriveBomFromBytes(buf, "stl", "Quad", validateDeriveOptions({ materialKey: "al6061" }));
    assert.equal(derivation.split, "named_groups");
    assert.deepEqual(lines.map((l) => l.partName), ["hub", "arm"]);
    assert.equal(lines[0]!.massG, 21.6); // 8 cm³ × 2.70
    assert.equal(lines[1]!.volumeMm3, 4000);
  });

  it("deterministic: same bytes + options → same lines", () => {
    const buf = binaryStl([...box(10), ...box(10, [30, 0, 0]), ...box(7, [60, 0, 0])]);
    const a = deriveBomFromBytes(buf, "stl", "M", PLA);
    const b = deriveBomFromBytes(buf, "stl", "M", PLA);
    assert.deepEqual(a.lines, b.lines);
  });
});

describe("derive options", () => {
  it("validates material, custom density and cost", () => {
    assert.ok(BOM_MATERIALS.every((m) => m.densityGPerCm3 > 0 && m.source.length > 0));
    assert.equal(code(() => validateDeriveOptions({ materialKey: "unobtainium" })), "INVALID_DERIVE_OPTIONS");
    assert.equal(code(() => validateDeriveOptions({ costPerKgUsd: 10 })), "INVALID_DERIVE_OPTIONS");
    assert.equal(code(() => validateDeriveOptions({ materialKey: "pla", costPerKgUsd: -1 })), "INVALID_DERIVE_OPTIONS");
    assert.equal(code(() => validateDeriveOptions({ materialKey: "pla", costPerKgUsd: "NaN" })), "INVALID_DERIVE_OPTIONS");
    assert.equal(
      code(() => validateDeriveOptions({ customMaterial: { label: "Mystery", densityGPerCm3: Infinity } })),
      "INVALID_DERIVE_OPTIONS",
    );
    assert.equal(code(() => validateDeriveOptions({ customMaterial: { label: "", densityGPerCm3: 1 } })), "INVALID_DERIVE_OPTIONS");
    const custom = validateDeriveOptions({ customMaterial: { label: "Tough resin", densityGPerCm3: "1.17" } });
    assert.equal(custom.material?.densityGPerCm3, 1.17);
    assert.match(custom.material!.source, /Entered by the workspace/);
  });

  it("derived sources can't be typed in by hand; unknown methods stay unsupported", () => {
    assert.deepEqual(DERIVED_METHODS, ["mesh_bodies"]);
    assert.equal(code(() => validateBomLineInput({ partName: "X", qty: 1, source: "derived:mesh_bodies" })), "DERIVED_LINE_NOT_MANUAL");
    assert.equal(code(() => validateBomLineInput({ partName: "X", qty: 1, source: "derived:fastener_count" })), "DERIVED_METHOD_UNSUPPORTED");
  });
});

describe("rollups across revisions", () => {
  const v1 = computeBomRollup([
    { id: "a", partName: "Arm", qty: 4, unitName: "pcs", materialSpec: "PLA", unitCostUsd: 1.5, source: DERIVED_LINE_SOURCE, volumeMm3: 4000, massG: 4.96 },
    { id: "b", partName: "Hub", qty: 1, unitName: "pcs", materialSpec: "PLA", unitCostUsd: null, source: DERIVED_LINE_SOURCE, volumeMm3: 8000, massG: 9.92 },
    { id: "c", partName: "M3 screw", qty: 16, unitName: "pcs", unitCostUsd: 0.05, source: "manual" },
  ]);
  const v2 = computeBomRollup([
    { id: "a2", partName: "Arm", qty: 4, unitName: "pcs", materialSpec: "PLA", unitCostUsd: 1.8, source: DERIVED_LINE_SOURCE, volumeMm3: 4800, massG: 5.95 },
    { id: "b2", partName: "Hub", qty: 1, unitName: "pcs", materialSpec: "PLA", unitCostUsd: null, source: DERIVED_LINE_SOURCE, volumeMm3: 8000, massG: 9.92 },
    { id: "d2", partName: "Battery tray", qty: 1, unitName: "pcs", materialSpec: "PLA", unitCostUsd: 0.9, source: DERIVED_LINE_SOURCE, volumeMm3: 2000, massG: 2.48 },
  ]);

  it("mass totals count known masses only and flag the rest", () => {
    assert.equal(v1.totalMassG, 29.76); // 4×4.96 + 9.92
    assert.equal(v1.linesMissingMass, 1);
    assert.equal(v1.totalUsd, 6.8);
    assert.equal(v1.linesMissingCost, 1);
    const none = computeBomRollup([{ id: "x", partName: "X", qty: 1, unitName: "pcs", unitCostUsd: NaN, source: "manual", massG: NaN }]);
    assert.equal(none.totalMassG, null);
    assert.equal(none.lines[0]!.unitCostUsd, null);
    assert.equal(none.totalUsd, 0);
  });

  it("compareBomRollups: added / removed / changed / unchanged with deltas", () => {
    const c = compareBomRollups(v1, v2);
    const by = Object.fromEntries(c.lines.map((l) => [l.partName, l]));
    assert.equal(by["Battery tray"]!.status, "added");
    assert.equal(by["M3 screw"]!.status, "removed");
    assert.equal(by["M3 screw"]!.qtyDelta, -16);
    assert.equal(by["Arm"]!.status, "changed");
    assert.equal(by["Arm"]!.lineTotalDeltaUsd, 1.2);
    assert.equal(by["Hub"]!.status, "unchanged");
    assert.deepEqual(
      [c.totals.added, c.totals.removed, c.totals.changed],
      [1, 1, 1],
    );
    assert.equal(c.totals.totalDeltaUsd, round2(v2.totalUsd - v1.totalUsd));
    assert.equal(c.totals.massDeltaG, round2(v2.totalMassG! - v1.totalMassG!));
    assert.deepEqual(c.lines.map((l) => l.status), ["added", "changed", "removed", "unchanged"]);
  });
});

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

describe("BOM CSV export", () => {
  it("neutralizes formula injection, quotes RFC 4180, leaves unknowns empty", () => {
    const rollup = computeBomRollup([
      { id: "1", partName: '=HYPERLINK("http://evil","x")', qty: 1, unitName: "pcs", supplier: "@SUM(A1)", unitCostUsd: 2, source: "manual" },
      { id: "2", partName: "+cmd|'/c calc'!A1", qty: 2, unitName: "pcs", materialSpec: "-PLA, black", unitCostUsd: null, source: DERIVED_LINE_SOURCE, volumeMm3: 1000, massG: 1.24 },
      { id: "3", partName: "Plain\nmultiline", qty: 3, unitName: "pcs", unitCostUsd: 0.1, source: "manual" },
    ]);
    const rows = bomCsvRows(rollup);
    const csv = rows.map((r) => csvRow(r)).join("\r\n");
    const lines = csv.split("\r\n");
    assert.equal(lines[0], "part,qty,unit,material,supplier,volume_cm3_per_unit,mass_g_per_unit,line_mass_g,unit_cost_usd,line_total_usd,cost_known,source");
    assert.equal(lines[1], `"'=HYPERLINK(""http://evil"",""x"")",1,pcs,,'@SUM(A1),,,,2,2,yes,manual`);
    assert.equal(lines[2], `'+cmd|'/c calc'!A1,2,pcs,"'-PLA, black",,1,1.24,2.48,,,no,derived:mesh_bodies`);
    assert.ok(csv.includes('"Plain\nmultiline"'));
    const total = rows[rows.length - 1]!;
    assert.equal(total[0], "TOTAL");
    assert.equal(total[9], rollup.totalUsd);
    assert.match(String(total[10]), /lower bound \(1 line/);
    // No cell starts with a raw formula trigger.
    for (const r of rows) for (const cell of r.map((v) => csvRow([v]))) assert.doesNotMatch(cell, /^"?[=+@]/);
  });
});
