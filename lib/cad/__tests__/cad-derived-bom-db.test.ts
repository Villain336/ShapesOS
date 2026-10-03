// ShapesOS — CAD derived BOM against Postgres (Phase 4b): derive from stored
// version bytes, pin + lineage, manual-line rules, rollups across revisions,
// CSV export, NaN/STEP/tamper refusals, tenant isolation.
// Run: DATABASE_URL=… npx tsx --test lib/cad/__tests__/cad-derived-bom-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const STORAGE_DIR = mkdtempSync(path.join(tmpdir(), "cad-derived-bom-"));
process.env.MARKETR_STORAGE = "local";
process.env.MARKETR_STORAGE_DIR = STORAGE_DIR;

import { prisma } from "../../prisma";
import { PrismaCadPipelineStore } from "../pipeline-store";
import { CadError } from "../types";
import { resetStorageAdapterForTests } from "../../filesystem/storage";
import { searchRecords } from "../../search/records";

const store = new PrismaCadPipelineStore(prisma);
const workspaces: string[] = [];
const ACTOR = "tico@test";

type Tri = number[];
function box(size: number, [ox, oy, oz]: [number, number, number] = [0, 0, 0]): Tri[] {
  const unit: Tri[] = [
    [0, 0, 0, 0, 1, 0, 1, 1, 0], [0, 0, 0, 1, 1, 0, 1, 0, 0],
    [0, 0, 1, 1, 0, 1, 1, 1, 1], [0, 0, 1, 1, 1, 1, 0, 1, 1],
    [0, 0, 0, 1, 0, 0, 1, 0, 1], [0, 0, 0, 1, 0, 1, 0, 0, 1],
    [0, 1, 0, 0, 1, 1, 1, 1, 1], [0, 1, 0, 1, 1, 1, 1, 1, 0],
    [0, 0, 0, 0, 0, 1, 0, 1, 1], [0, 0, 0, 0, 1, 1, 0, 1, 0],
    [1, 0, 0, 1, 1, 0, 1, 1, 1], [1, 0, 0, 1, 1, 1, 1, 0, 1],
  ];
  return unit.map((t) => t.map((v, i) => [ox, oy, oz][i % 3]! + v * size));
}
function binaryStl(tris: Tri[]): Buffer {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => t.forEach((v, k) => buf.writeFloatLE(v, 84 + i * 50 + 12 + k * 4)));
  return buf;
}

async function makeWorkspace(): Promise<string> {
  const ws = await prisma.workspace.create({
    data: { name: `test-cad-bom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ownerUserId: "test-cad-bom" },
  });
  workspaces.push(ws.id);
  return ws.id;
}

async function makeModel(ws: string, name: string, bytes: Buffer, fileName = "part.stl") {
  const project = await store.createProject(ws, ACTOR, { name: "Drone" });
  return store.createModelWithVersion(ws, ACTOR, project.id, { name }, { fileName, fileBytes: bytes });
}

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof CadError ? e.code : `non-cad:${e instanceof Error ? e.message : String(e)}`;
  }
}

before(() => resetStorageAdapterForTests());
after(async () => {
  for (const id of workspaces) await prisma.workspace.deleteMany({ where: { id } }).catch(() => {});
  rmSync(STORAGE_DIR, { recursive: true, force: true });
  resetStorageAdapterForTests();
});

describe("derived BOM (db)", () => {
  it("derives from the stored bytes, pins to the version, records lineage", async () => {
    const ws = await makeWorkspace();
    const tris = [...box(10), ...box(10, [40, 0, 0]), ...box(20, [80, 0, 0])];
    const { model, version } = await makeModel(ws, "Airframe", binaryStl(tris));
    const res = await store.deriveBomFromGeometry(ws, ACTOR, model.id, version.id, { materialKey: "pla", costPerKgUsd: 25 });
    assert.equal(res.bom.origin, "derived");
    assert.equal(res.bom.modelVersionId, version.id);
    assert.equal(res.bom.bomNumber, 1);
    assert.equal(res.bom.lines.length, 2);
    assert.deepEqual(res.bom.lines.map((l) => [l.qty, l.volumeMm3, l.massG]), [[1, 8000, 9.92], [2, 1000, 1.24]]);
    assert.ok(res.bom.lines.every((l) => l.source === "derived:mesh_bodies"));
    assert.equal(res.rollup.totalMassG, 12.4);
    assert.equal(res.rollup.totalUsd, round2(0.248 + 2 * 0.031));
    assert.equal(res.derivation.sourceChecksum, version.checksum);
    assert.equal(res.derivation.sourceVersionNumber, 1);
    const stored = await store.getBomVersion(ws, res.bom.id);
    const derivation = stored.bom.derivation as { method: string; material: { label: string } };
    assert.equal(derivation.method, "mesh_bodies");
    assert.equal(derivation.material.label, "PLA");
    assert.equal(stored.rollup.lines[0]!.lineMassG, 9.92);
  });

  it("manual rules: derived sources can't be hand-entered; derived qty is locked; other edits allowed", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModel(ws, "Bracket", binaryStl(box(10)));
    const { bom } = await store.deriveBomFromGeometry(ws, ACTOR, model.id, version.id, {});
    assert.equal(
      await codeOf(store.addBomLine(ws, ACTOR, bom.id, { partName: "Fake", qty: 3, source: "derived:mesh_bodies" })),
      "DERIVED_LINE_NOT_MANUAL",
    );
    const manual = await store.addBomLine(ws, ACTOR, bom.id, { partName: "M3 screw", qty: 8, unitCostUsd: 0.05 });
    assert.equal(manual.source, "manual");
    const line = bom.lines[0]!;
    assert.equal(await codeOf(store.updateBomLine(ws, line.id, { qty: 5 })), "DERIVED_QTY_IMMUTABLE");
    const renamed = await store.updateBomLine(ws, line.id, { partName: "Bracket (left)", supplier: "In-house", unitCostUsd: 0.4 });
    assert.equal(renamed.partName, "Bracket (left)");
    assert.equal(renamed.volumeMm3, 1000);
    const { rollup } = await store.getBomVersion(ws, bom.id);
    assert.equal(rollup.totalUsd, 0.8);
    assert.equal(rollup.linesMissingMass, 2); // no material picked + the manual line
  });

  it("rollups across revisions: history ordered by version with deltas, and a part diff", async () => {
    const ws = await makeWorkspace();
    const { model, version: v1 } = await makeModel(ws, "Quad", binaryStl([...box(10), ...box(10, [40, 0, 0])]));
    const b1 = await store.deriveBomFromGeometry(ws, ACTOR, model.id, v1.id, { materialKey: "abs" });
    const v2 = await store.addModelVersion(ws, ACTOR, model.id, {
      fileName: "quad-v2.stl",
      fileBytes: binaryStl([...box(10), ...box(10, [40, 0, 0]), ...box(10, [80, 0, 0]), ...box(30, [120, 0, 0])]),
    });
    const b2 = await store.deriveBomFromGeometry(ws, ACTOR, model.id, v2.id, { materialKey: "abs" });
    assert.equal(b2.bom.bomNumber, 2);
    const history = await store.getBomHistory(ws, model.id);
    assert.deepEqual(history.map((h) => [h.versionNumber, h.bomNumber, h.origin]), [[1, 1, "derived"], [2, 2, "derived"]]);
    assert.equal(history[0]!.vsPrevious, null);
    assert.equal(history[1]!.vsPrevious!.added, 1);
    assert.equal(history[1]!.vsPrevious!.changed, 1); // the small part went 2 → 3
    assert.equal(history[1]!.totalMassG, round2(3 * 1.04 + 27 * 1.04));
    const cmp = await store.compareBomVersions(ws, b1.bom.id, b2.bom.id);
    assert.equal(cmp.comparison.totals.massDeltaG, round2(history[1]!.totalMassG! - history[0]!.totalMassG!));
    const changed = cmp.comparison.lines.find((l) => l.status === "changed")!;
    assert.equal(changed.qtyDelta, 1);
  });

  it("CSV export escapes formula-shaped names from the model", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModel(ws, '=HYPERLINK("http://evil","x")', binaryStl(box(10)));
    const { bom } = await store.deriveBomFromGeometry(ws, ACTOR, model.id, version.id, { materialKey: "pla" });
    await store.addBomLine(ws, ACTOR, bom.id, { partName: "@SUM(1+1)", qty: 2, supplier: "+cmd", unitCostUsd: 1 });
    const { filename, csv } = await store.exportBomCsv(ws, bom.id);
    assert.match(filename, /^bom-hyperlink-http-evil-x-v1-1\.csv$/);
    const lines = csv.split("\r\n");
    assert.match(lines[0]!, /^part,qty,unit,material/);
    assert.ok(lines[1]!.startsWith(`"'=HYPERLINK(""http://evil"",""x"")",1,pcs,PLA,,1,1.24,1.24,`), lines[1]);
    assert.ok(lines[2]!.startsWith("'@SUM(1+1),2,pcs,,'+cmd,"), lines[2]);
    assert.ok(lines.some((l) => l.startsWith("TOTAL,")));
  });

  it("refuses NaN-only, STEP and tampered files without writing a BOM", async () => {
    const ws = await makeWorkspace();
    const nan = await makeModel(ws, "Broken", binaryStl([new Array(9).fill(NaN)]));
    assert.equal(await codeOf(store.deriveBomFromGeometry(ws, ACTOR, nan.model.id, nan.version.id, {})), "DERIVE_UNAVAILABLE");
    const step = await makeModel(
      ws,
      "Frame",
      Buffer.from("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('x'),'2;1');\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"),
      "frame.step",
    );
    assert.equal(await codeOf(store.deriveBomFromGeometry(ws, ACTOR, step.model.id, step.version.id, {})), "DERIVE_UNAVAILABLE");
    const ok = await makeModel(ws, "Plate", binaryStl(box(10)));
    await prisma.cadModelVersion.update({ where: { id: ok.version.id }, data: { checksum: "0".repeat(64) } });
    assert.equal(await codeOf(store.deriveBomFromGeometry(ws, ACTOR, ok.model.id, ok.version.id, {})), "FILE_INTEGRITY");
    assert.equal(
      await codeOf(store.deriveBomFromGeometry(ws, ACTOR, ok.model.id, ok.version.id, { materialKey: "nope" })),
      "INVALID_DERIVE_OPTIONS",
    );
    assert.equal(await prisma.cadBomVersion.count({ where: { workspaceId: ws } }), 0);
  });

  it("record search finds BOM parts (deep link to the model's prototype tab), own workspace only", async () => {
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    const { model, version } = await makeModel(a, "Gimbal", binaryStl(box(10)));
    const { bom } = await store.deriveBomFromGeometry(a, ACTOR, model.id, version.id, { materialKey: "ti64" });
    await store.addBomLine(a, ACTOR, bom.id, { partName: "Quillwort bearing 608ZZ", qty: 2 });
    const hits = await searchRecords(a, "viewer", "quillwort", { kinds: ["bom_line"] });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.title, "Quillwort bearing 608ZZ");
    assert.match(hits[0]!.subtitle ?? "", /Gimbal · BOM #1 · v1/);
    assert.equal(
      hits[0]!.href,
      `/dashboard/cad?project=${model.projectId}&model=${model.id}&tab=prototype`,
    );
    const byMaterial = await searchRecords(a, "viewer", "Ti-6Al", { kinds: ["bom_line"] });
    assert.equal(byMaterial.length, 1);
    assert.deepEqual(await searchRecords(b, "viewer", "quillwort", { kinds: ["bom_line"] }), []);
  });

  it("tenant isolation: another workspace can't derive, read, export or compare", async () => {
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    const { model, version } = await makeModel(a, "Secret part", binaryStl(box(10)));
    const { bom } = await store.deriveBomFromGeometry(a, ACTOR, model.id, version.id, {});
    assert.equal(await codeOf(store.deriveBomFromGeometry(b, ACTOR, model.id, version.id, {})), "MODEL_NOT_FOUND");
    assert.equal(await codeOf(store.getBomVersion(b, bom.id)), "BOM_NOT_FOUND");
    assert.equal(await codeOf(store.exportBomCsv(b, bom.id)), "BOM_NOT_FOUND");
    assert.equal(await codeOf(store.getBomHistory(b, model.id)), "MODEL_NOT_FOUND");
    const own = await makeModel(b, "Mine", binaryStl(box(5)));
    const mine = await store.deriveBomFromGeometry(b, ACTOR, own.model.id, own.version.id, {});
    assert.equal(await codeOf(store.compareBomVersions(b, mine.bom.id, bom.id)), "BOM_NOT_FOUND");
  });
});

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
