// ShapesOS — CAD: an STL with NaN/Infinity coordinates never yields
// "computed" manufacturability results (FULL-AUDIT §5; regression for the
// edge2/cad1.ts probe).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractMeshTriangles, parseMeshStats } from "../geometry";
import { runManufacturabilityChecks } from "../manufacturability";

/** Binary STL from triangles (9 floats each). */
function binaryStl(tris: number[][]): Buffer {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => t.forEach((v, k) => buf.writeFloatLE(v, 84 + i * 50 + 12 + k * 4)));
  return buf;
}

const GOOD = [
  [0, 0, 0, 10, 0, 0, 0, 10, 0],
  [0, 0, 0, 0, 10, 0, 0, 0, 10],
  [0, 0, 0, 0, 0, 10, 10, 0, 0],
  [10, 0, 0, 0, 0, 10, 0, 10, 0],
];

describe("non-finite STL geometry", () => {
  it("an all-NaN STL has no stats, no triangles, and unavailable checks", () => {
    const buf = binaryStl([new Array(9).fill(NaN)]);
    assert.equal(parseMeshStats(buf, "stl"), null);
    assert.equal(extractMeshTriangles(buf, "stl"), null);
  });

  it("NaN / Infinity triangles are dropped; the rest is measured", () => {
    const buf = binaryStl([...GOOD, [NaN, 0, 0, 1, 1, 1, 2, 2, 2], [0, 0, 0, Infinity, 0, 0, 0, 1, 0]]);
    const stats = parseMeshStats(buf, "stl");
    assert.ok(stats);
    assert.equal(stats.triangleCount, 4);
    assert.deepEqual(stats.bboxMax, [10, 10, 10]);
    assert.ok(Number.isFinite(stats.volumeEstimate));
    const tris = extractMeshTriangles(buf, "stl");
    assert.ok(tris);
    assert.equal(tris.triangleCount, 4);
    assert.equal(tris.positions.length, 36);
    assert.ok(tris.positions.every(Number.isFinite));
    const r = runManufacturabilityChecks(tris.positions, tris.triangleCount);
    assert.ok(r.checks.every((c) => c.status === "computed"));
    for (const c of r.checks) assert.doesNotMatch(c.detail, /NaN|Infinity/);
  });

  it("runManufacturabilityChecks refuses NaN positions from any caller", () => {
    const nanBig = new Float32Array(9 * 50).map((_, i) => (i % 9 === 0 ? NaN : i));
    const r = runManufacturabilityChecks(nanBig, 50);
    assert.deepEqual(r.checks.map((c) => c.status), ["unavailable", "unavailable", "unavailable"]);
    assert.equal(r.flags.length, 0);
  });
});
