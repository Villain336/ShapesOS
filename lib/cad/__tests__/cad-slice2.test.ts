// Marketr — CAD + Hardware slice 2 tests: NL annotations, design-change
// proposals (draft-for-approval), manufacturability checks.
// Run: npx tsx --test lib/cad/__tests__/cad-slice2.test.ts
//
// DB-backed tests run against the local dev DB and clean up their own test
// workspaces (cascades purge CAD rows). Parser/manufacturability tests are
// pure. Fixtures are REAL mesh bytes, not mocks.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../../prisma";
import { PrismaCadAiStore, requireCadHuman } from "../ai-store";
import { extractMeshTriangles } from "../geometry";
import {
  runManufacturabilityChecks,
  MFG_REFERENCES,
  UNIT_ASSUMPTION,
  OVERHANG_ANGLE_DEG,
  MIN_WALL_MM,
} from "../manufacturability";
import { parseDesignRequest, validateTargetRegion } from "../design-proposals";
import { CadError } from "../types";

const store = new PrismaCadAiStore(prisma);
const testWorkspaceIds: string[] = [];

async function makeWorkspace(): Promise<string> {
  const ws = await prisma.workspace.create({
    data: {
      name: `test-cad-slice2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ownerUserId: "test-cad-slice2",
    },
  });
  testWorkspaceIds.push(ws.id);
  return ws.id;
}

after(async () => {
  for (const id of testWorkspaceIds) {
    await prisma.workspace.deleteMany({ where: { id } }).catch(() => {});
  }
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof CadError, `expected CadError, got ${e}`);
    return e.code;
  }
  assert.fail("expected a CadError to be thrown");
}

// ---------- Test fixtures: real mesh bytes, not mocks ----------

// 12-triangle box, outward normals, centered at (cx,cy,cz), size w×d×h.
function boxTris(w: number, d: number, h: number, cx = 0, cy = 0, cz = 0): number[][][] {
  const x0 = cx - w / 2, x1 = cx + w / 2;
  const y0 = cy - d / 2, y1 = cy + d / 2;
  const z0 = cz - h / 2, z1 = cz + h / 2;
  return [
    [[x0,y0,z1],[x1,y0,z1],[x1,y1,z1]], [[x0,y0,z1],[x1,y1,z1],[x0,y1,z1]], // +z
    [[x0,y0,z0],[x1,y1,z0],[x1,y0,z0]], [[x0,y0,z0],[x0,y1,z0],[x1,y1,z0]], // -z
    [[x1,y0,z0],[x1,y1,z1],[x1,y0,z1]], [[x1,y0,z0],[x1,y1,z0],[x1,y1,z1]], // +x
    [[x0,y0,z0],[x0,y0,z1],[x0,y1,z1]], [[x0,y0,z0],[x0,y1,z1],[x0,y1,z0]], // -x
    [[x0,y1,z0],[x0,y1,z1],[x1,y1,z1]], [[x0,y1,z0],[x1,y1,z1],[x1,y1,z0]], // +y
    [[x0,y0,z0],[x1,y0,z1],[x0,y0,z1]], [[x0,y0,z0],[x1,y0,z0],[x1,y0,z1]], // -y
  ];
}

function binaryStl(tris: number[][][]): Buffer {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write("binary STL fixture", 0);
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => {
    const off = 84 + i * 50;
    for (let k = 0; k < 3; k++) {
      buf.writeFloatLE(t[k]![0], off + 12 + k * 12);
      buf.writeFloatLE(t[k]![1], off + 16 + k * 12);
      buf.writeFloatLE(t[k]![2], off + 20 + k * 12);
    }
  });
  return buf;
}

function stepSnippet(): Buffer {
  return Buffer.from(
    "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('drone airframe'),'2;1');\nENDSEC;\nDATA;\n#1=CARTESIAN_POINT('p',(0.,0.,0.));\nENDSEC;\nEND-ISO-10303-21;\n",
  );
}

// A thin plate: 10×10×0.5 — walls below the 0.8mm guideline.
const THIN_PLATE = () => binaryStl(boxTris(10, 10, 0.5));
// A chunky cube: 10³ — nothing to flag.
const CHUNKY_CUBE = () => binaryStl(boxTris(10, 10, 10));
// A pillar with a mid-height lip: the lip underside overhangs above the plate.
const OVERHANG_SHELF = () =>
  binaryStl([...boxTris(2, 2, 10, 0, 0, 5), ...boxTris(6, 2, 1, 0, 0, 4.5)]);
// A foil: 10×10×0.05 — below slicing floor + resolution.
const FOIL = () => binaryStl(boxTris(10, 10, 0.05));

async function makeModelWithVersion(
  ws: string,
  fileName: string,
  fileBytes: Buffer,
) {
  const project = await store.createProject(ws, "tester", { name: "drone airframe" });
  const { model, version } = await store.createModelWithVersion(
    ws,
    "tester",
    project.id,
    { name: "test part" },
    { fileName, fileBytes },
  );
  return { project, model, version };
}

// ---------- triangle extraction ----------

describe("extractMeshTriangles (real geometry for the analysis)", () => {
  it("extracts 12 triangles from a binary STL box", () => {
    const mesh = extractMeshTriangles(THIN_PLATE(), "stl");
    assert.ok(mesh);
    assert.equal(mesh.triangleCount, 12);
    assert.equal(mesh.positions.length, 12 * 9);
  });
  it("returns null for STEP — never faked", () => {
    assert.equal(extractMeshTriangles(stepSnippet(), "step"), null);
  });
  it("returns null for garbage", () => {
    assert.equal(extractMeshTriangles(Buffer.from("not a mesh"), "stl"), null);
  });
});

// ---------- manufacturability (pure) ----------

describe("manufacturability checks on fixture geometry", () => {
  it("flags the thin plate's walls with the cited measurement", () => {
    const mesh = extractMeshTriangles(THIN_PLATE(), "stl")!;
    const result = runManufacturabilityChecks(mesh.positions, mesh.triangleCount);
    const wall = result.flags.find((f) => f.checkType === "wall_thickness");
    assert.ok(wall, "expected a wall_thickness flag");
    const minWall = wall.measurement.minWallMm as number;
    assert.ok(minWall > 0.4 && minWall < 0.6, `minWall ${minWall} should be ≈0.5`);
    assert.equal(wall.measurement.thresholdMm, MIN_WALL_MM);
    assert.equal(wall.measurement.unit, UNIT_ASSUMPTION);
    assert.equal(wall.severity, "warning");
    // The numbers are cited, not invented: sample + threshold are present.
    assert.ok((wall.measurement.sampledFaces as number) > 0);
    assert.equal(wall.measurement.totalFaces, 12);
  });
  it("does not flag the plate bottom as an overhang (it sits on the plate)", () => {
    const mesh = extractMeshTriangles(THIN_PLATE(), "stl")!;
    const result = runManufacturabilityChecks(mesh.positions, mesh.triangleCount);
    const over = result.flags.filter((f) => f.checkType === "overhang");
    assert.equal(over.length, 0);
  });
  it("flags the shelf lip underside as an overhang, citing the angle", () => {
    const mesh = extractMeshTriangles(OVERHANG_SHELF(), "stl")!;
    const result = runManufacturabilityChecks(mesh.positions, mesh.triangleCount);
    const over = result.flags.find((f) => f.checkType === "overhang");
    assert.ok(over, "expected an overhang flag");
    assert.equal(over.measurement.angleThresholdDeg, OVERHANG_ANGLE_DEG);
    assert.ok((over.measurement.flaggedFaces as number) > 0);
    assert.ok((over.measurement.steepestFaceDeg as number) > OVERHANG_ANGLE_DEG);
  });
  it("flags the foil for tolerance risks, citing measurements", () => {
    const mesh = extractMeshTriangles(FOIL(), "stl")!;
    const result = runManufacturabilityChecks(mesh.positions, mesh.triangleCount);
    const tol = result.flags.filter((f) => f.checkType === "tolerance");
    assert.ok(tol.length >= 1, "expected tolerance flags");
    const dimFlag = tol.find((f) => (f.measurement.smallestDimensionMm as number) < 0.4);
    assert.ok(dimFlag, "expected the sub-slicing-floor dimension flag");
    assert.ok((dimFlag.measurement.smallestDimensionMm as number) < 0.1);
  });
  it("finds nothing to flag on the chunky cube", () => {
    const mesh = extractMeshTriangles(CHUNKY_CUBE(), "stl")!;
    const result = runManufacturabilityChecks(mesh.positions, mesh.triangleCount);
    assert.equal(result.flags.length, 0);
    assert.ok(result.checks.every((c) => c.status === "computed"));
  });
  it("reports unavailable — never invented numbers — on empty input", () => {
    const result = runManufacturabilityChecks(new Float32Array(0), 0);
    assert.equal(result.flags.length, 0);
    assert.ok(result.checks.every((c) => c.status === "unavailable"));
  });
});

// ---------- natural-language parsing (pure) ----------

describe("parseDesignRequest (deterministic, auditable)", () => {
  it("parses 'thicken this wall to 3mm'", () => {
    const p = parseDesignRequest("thicken this wall to 3mm");
    assert.equal(p.operation, "thicken_wall");
    assert.equal(p.parameters.targetThicknessMm, 3);
    assert.equal(p.parameters.unit, "mm");
    assert.equal(p.featureLabel, "this wall");
    assert.equal(p.confidence, "high");
    assert.equal(p.recognized, true);
  });
  it("parses 'drill a 6mm hole in the base' with rationale", () => {
    const p = parseDesignRequest("drill a 6mm hole in the base so the motor fits");
    assert.equal(p.operation, "add_hole");
    assert.equal(p.parameters.diameterMm, 6);
    assert.ok(p.rationale && p.rationale.includes("motor fits"));
  });
  it("normalizes units to mm (2cm → 20, 1in → 25.4)", () => {
    assert.equal(parseDesignRequest("add a 2cm hole").parameters.diameterMm, 20);
    assert.equal(parseDesignRequest("chamfer the top edge by 1in").parameters.distanceMm, 25.4);
    assert.equal(parseDesignRequest("chamfer the top edge by 1in").operation, "chamfer_edge");
  });
  it("is honest about unrecognized requests", () => {
    const p = parseDesignRequest("please do something nice");
    assert.equal(p.operation, "unrecognized");
    assert.equal(p.recognized, false);
    assert.equal(p.confidence, "low");
  });
  it("rejects empty requests", async () => {
    assert.equal(await codeOf(Promise.resolve().then(() => parseDesignRequest("   "))), "INVALID_REQUEST");
  });
  it("validates target regions", async () => {
    assert.equal(
      await codeOf(
        Promise.resolve().then(() =>
          validateTargetRegion({ min: [1, 0, 0], max: [0, 1, 1] }),
        ),
      ),
      "INVALID_REGION",
    );
    validateTargetRegion(null);
    validateTargetRegion({ min: [0, 0, 0], max: [1, 1, 1] });
  });
});

// ---------- annotations (DB) ----------

describe("annotations", () => {
  it("creates, lists (per-version), and deletes annotations", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModelWithVersion(ws, "plate.stl", THIN_PLATE());
    const a = await store.createAnnotation(ws, "t@t.co", model.id, version.id, "Check this rib.", {
      kind: "point",
      point: [1, 2, 0.25],
    });
    assert.equal(a.body, "Check this rib.");
    assert.deepEqual(a.point, [1, 2, 0.25]);
    const list = await store.listAnnotations(ws, model.id, version.id);
    assert.equal(list.length, 1);
    const whole = await store.createAnnotation(ws, "t@t.co", model.id, version.id, "Whole note.", { kind: "whole" });
    assert.equal(whole.point, null);
    assert.equal((await store.listAnnotations(ws, model.id)).length, 2);
    await store.deleteAnnotation(ws, a.id);
    assert.equal((await store.listAnnotations(ws, model.id)).length, 1);
  });
  it("rejects bad anchors and empty bodies", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModelWithVersion(ws, "plate.stl", THIN_PLATE());
    assert.equal(
      await codeOf(store.createAnnotation(ws, "t@t.co", model.id, version.id, "x", { kind: "point", point: [1, 2, NaN] })),
      "INVALID_ANCHOR",
    );
    assert.equal(
      await codeOf(store.createAnnotation(ws, "t@t.co", model.id, version.id, "   ", { kind: "whole" })),
      "INVALID_BODY",
    );
  });
  it("is tenant-isolated", async () => {
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();
    const { model, version } = await makeModelWithVersion(wsA, "plate.stl", THIN_PLATE());
    const other = await makeModelWithVersion(wsB, "plate.stl", THIN_PLATE());
    // Tenant B cannot annotate tenant A's model…
    assert.equal(
      await codeOf(store.createAnnotation(wsB, "t@t.co", model.id, version.id, "sneaky", { kind: "whole" })),
      "MODEL_NOT_FOUND",
    );
    // …nor borrow its version id…
    assert.equal(
      await codeOf(store.createAnnotation(wsB, "t@t.co", other.model.id, version.id, "sneaky", { kind: "whole" })),
      "VERSION_NOT_FOUND",
    );
    // …nor read or delete its annotations.
    await store.createAnnotation(wsA, "t@t.co", model.id, version.id, "mine", { kind: "whole" });
    assert.equal((await store.listAnnotations(wsB, other.model.id)).length, 0);
    const row = await store.listAnnotations(wsA, model.id);
    assert.equal(await codeOf(store.deleteAnnotation(wsB, row[0]!.id)), "ANNOTATION_NOT_FOUND");
  });
});

// ---------- proposals (DB) ----------

describe("design proposals: the approval queue", () => {
  it("parses the request into a draft — the model is untouched", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModelWithVersion(ws, "plate.stl", THIN_PLATE());
    const { proposal, parse } = await store.createProposal(
      ws, "t@t.co", model.id, version.id, "thicken this wall to 3mm",
    );
    assert.equal(proposal.status, "draft");
    assert.equal(proposal.operation, "thicken_wall");
    assert.equal(parse.confidence, "high");
    const fresh = await prisma.cadModel.findUnique({ where: { id: model.id } });
    assert.equal(fresh!.changeRequested, false);
  });
  it("an agent cannot approve or reject (human-only)", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModelWithVersion(ws, "plate.stl", THIN_PLATE());
    const { proposal } = await store.createProposal(ws, "t@t.co", model.id, version.id, "thicken this wall to 3mm");
    const agent = { kind: "agent" as const, identity: "agent-1" };
    assert.equal(await codeOf(store.approveProposal(ws, agent, proposal.id)), "AGENT_CANNOT_ACT");
    assert.equal(await codeOf(store.rejectProposal(ws, agent, proposal.id)), "AGENT_CANNOT_ACT");
    const still = await store.getProposal(ws, proposal.id);
    assert.equal(still.status, "draft");
    assert.equal((await prisma.cadModel.findUnique({ where: { id: model.id } }))!.changeRequested, false);
  });
  it("approval marks the model change-requested WITHOUT touching geometry (anti-violation)", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModelWithVersion(ws, "plate.stl", THIN_PLATE());
    const { proposal } = await store.createProposal(ws, "t@t.co", model.id, version.id, "thicken this wall to 3mm");
    const before = await prisma.cadModelVersion.findMany({ where: { modelId: model.id, workspaceId: ws } });
    const beforeSnap = before.map((v) => ({
      id: v.id, checksum: v.checksum, triangleCount: v.triangleCount,
      bboxMin: v.bboxMin, bboxMax: v.bboxMax, volumeEstimate: v.volumeEstimate,
    }));
    const approved = await store.approveProposal(
      ws, { kind: "human", identity: "t@t.co" }, proposal.id, "looks right",
    );
    assert.equal(approved.status, "approved");
    assert.equal(approved.decidedBy, "t@t.co");
    const modelRow = await prisma.cadModel.findUnique({ where: { id: model.id } });
    assert.equal(modelRow!.changeRequested, true);
    assert.equal(modelRow!.changeRequestedProposalId, proposal.id);
    // THE BOUNDARY: no version row was created, and no published geometry
    // row changed — checksum, triangles, bbox, volume all identical.
    const after = await prisma.cadModelVersion.findMany({ where: { modelId: model.id, workspaceId: ws } });
    assert.equal(after.length, before.length);
    const afterSnap = after.map((v) => ({
      id: v.id, checksum: v.checksum, triangleCount: v.triangleCount,
      bboxMin: v.bboxMin, bboxMax: v.bboxMax, volumeEstimate: v.volumeEstimate,
    }));
    assert.deepEqual(afterSnap, beforeSnap);
  });
  it("rejection leaves the model untouched; transitions are one-way", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModelWithVersion(ws, "plate.stl", THIN_PLATE());
    const { proposal } = await store.createProposal(ws, "t@t.co", model.id, version.id, "add a hole");
    const rejected = await store.rejectProposal(ws, { kind: "human", identity: "t@t.co" }, proposal.id);
    assert.equal(rejected.status, "rejected");
    assert.equal((await prisma.cadModel.findUnique({ where: { id: model.id } }))!.changeRequested, false);
    assert.equal(
      await codeOf(store.approveProposal(ws, { kind: "human", identity: "t@t.co" }, proposal.id)),
      "INVALID_TRANSITION",
    );
  });
  it("publishing a new version clears the change request", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModelWithVersion(ws, "plate.stl", THIN_PLATE());
    const { proposal } = await store.createProposal(ws, "t@t.co", model.id, version.id, "thicken this wall to 3mm");
    await store.approveProposal(ws, { kind: "human", identity: "t@t.co" }, proposal.id);
    assert.equal((await prisma.cadModel.findUnique({ where: { id: model.id } }))!.changeRequested, true);
    await store.addModelVersion(ws, "t@t.co", model.id, { fileName: "plate-v2.stl", fileBytes: CHUNKY_CUBE() });
    const cleared = await prisma.cadModel.findUnique({ where: { id: model.id } });
    assert.equal(cleared!.changeRequested, false);
    assert.equal(cleared!.changeRequestedProposalId, null);
  });
  it("the human can fix the parse while the draft is open", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModelWithVersion(ws, "plate.stl", THIN_PLATE());
    const { proposal } = await store.createProposal(ws, "t@t.co", model.id, version.id, "make it nicer");
    assert.equal(proposal.operation, "unrecognized");
    const fixed = await store.updateProposalDraft(ws, proposal.id, {
      operation: "smooth_region",
      parameters: { unit: "mm" },
      rationale: "surface finish",
    });
    assert.equal(fixed.operation, "smooth_region");
    assert.equal(fixed.rationale, "surface finish");
    // Closed drafts cannot be edited.
    await store.rejectProposal(ws, { kind: "human", identity: "t@t.co" }, proposal.id);
    assert.equal(
      await codeOf(store.updateProposalDraft(ws, proposal.id, { rationale: "too late" })),
      "INVALID_TRANSITION",
    );
  });
  it("is tenant-isolated", async () => {
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();
    const { model, version } = await makeModelWithVersion(wsA, "plate.stl", THIN_PLATE());
    const { proposal } = await store.createProposal(wsA, "t@t.co", model.id, version.id, "thicken this wall to 3mm");
    assert.equal((await store.listProposals(wsB, (await makeModelWithVersion(wsB, "p.stl", THIN_PLATE())).model.id)).length, 0);
    assert.equal(await codeOf(store.getProposal(wsB, proposal.id)), "PROPOSAL_NOT_FOUND");
    assert.equal(
      await codeOf(store.approveProposal(wsB, { kind: "human", identity: "x" }, proposal.id)),
      "PROPOSAL_NOT_FOUND",
    );
  });
});

// ---------- manufacturability (DB) ----------

describe("manufacturability runs", () => {
  it("runs the analysis on a mesh version and stores cited flags", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModelWithVersion(ws, "plate.stl", THIN_PLATE());
    const { run, flags } = await store.runManufacturability(ws, "t@t.co", model.id, version.id);
    assert.equal(run.status, "complete");
    assert.ok((run.checks as unknown[]).length === 3);
    assert.ok(flags.length >= 1);
    const wall = flags.find((f) => f.checkType === "wall_thickness")!;
    assert.ok(wall, "expected a wall flag");
    assert.ok((wall.measurement as Record<string, number>).minWallMm < MIN_WALL_MM);
    // Clean sourcing: every run carries its process-limit source pointers.
    assert.ok((run.references as unknown[]).length >= 2);
    assert.ok(
      (run.references as unknown as typeof MFG_REFERENCES).every((r) => r.source.startsWith("http") && r.rule.length > 0),
    );
    assert.ok(run.unitAssumption.includes("assumed"));
  });
  it("STEP returns 'unavailable' — never invented numbers (anti-violation)", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModelWithVersion(ws, "airframe.step", stepSnippet());
    const { run, flags } = await store.runManufacturability(ws, "t@t.co", model.id, version.id);
    assert.equal(run.status, "unavailable");
    assert.ok(run.unavailableReason && run.unavailableReason.includes("STEP"));
    assert.equal(flags.length, 0, "STEP must produce zero flags — no invented analysis");
    assert.ok((run.checks as { status: string }[]).every((c) => c.status === "unavailable"));
  });
  it("the chunky cube completes with zero flags", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModelWithVersion(ws, "cube.stl", CHUNKY_CUBE());
    const { run, flags } = await store.runManufacturability(ws, "t@t.co", model.id, version.id);
    assert.equal(run.status, "complete");
    assert.equal(flags.length, 0);
  });
  it("dismissal requires a reason and is idempotent", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModelWithVersion(ws, "plate.stl", THIN_PLATE());
    const { flags } = await store.runManufacturability(ws, "t@t.co", model.id, version.id);
    const flag = flags[0]!;
    assert.equal(await codeOf(store.dismissFlag(ws, "t@t.co", flag.id, "   ")), "INVALID_REASON");
    const dismissed = await store.dismissFlag(ws, "t@t.co", flag.id, "Prototype only — single wall is fine for the fit check.");
    assert.equal(dismissed.dismissed, true);
    assert.equal(dismissed.dismissalReason, "Prototype only — single wall is fine for the fit check.");
    const again = await store.dismissFlag(ws, "t@t.co", flag.id, "another reason");
    assert.equal(again.dismissalReason, "Prototype only — single wall is fine for the fit check.");
  });
  it("is tenant-isolated", async () => {
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();
    const { model, version } = await makeModelWithVersion(wsA, "plate.stl", THIN_PLATE());
    await store.runManufacturability(wsA, "t@t.co", model.id, version.id);
    const other = await makeModelWithVersion(wsB, "plate.stl", THIN_PLATE());
    assert.equal((await store.listMfgRuns(wsB, other.model.id)).length, 0);
    assert.equal(
      await codeOf(store.runManufacturability(wsB, "x", model.id, version.id)),
      "MODEL_NOT_FOUND",
    );
    const flag = (await store.listMfgFlags(wsA, model.id))[0]!;
    assert.equal(await codeOf(store.dismissFlag(wsB, "x", flag.id, "sneaky")), "FLAG_NOT_FOUND");
  });
});

// ---------- human-actor guard ----------

describe("requireCadHuman", () => {
  it("rejects agent actors and empty identities", () => {
    assert.throws(() => requireCadHuman({ kind: "agent", identity: "a" }, "x"), (e) => e instanceof CadError && e.code === "AGENT_CANNOT_ACT");
    assert.throws(() => requireCadHuman({ kind: "human", identity: "  " }, "x"), (e) => e instanceof CadError && e.code === "INVALID_ACTOR");
    assert.equal(requireCadHuman({ kind: "human", identity: " t@t.co " }, "x"), "t@t.co");
  });
});
