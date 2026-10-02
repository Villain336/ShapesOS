// Marketr — CAD + Hardware slice 1 tests: registry, versioning, honest
// geometry/diff stats, share-link fail-closed behavior, tenant isolation.
// Run: npx tsx --test lib/cad/__tests__/cad-slice1.test.ts
//
// DB-backed tests run against the local dev DB and clean up their own test
// workspaces (cascades purge CAD rows). Geometry/sniff/diff tests are pure.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../../prisma";
import { PrismaCadStore } from "../prisma-store";
import { sniffCadFormat, parseMeshStats } from "../geometry";
import { computeModelDiff } from "../diff";
import {
  CadError,
  SHARE_LINK_DEFAULT_EXPIRY_DAYS,
  SHARE_LINK_TOKEN_PREFIX,
  STEP_PREVIEW_MESSAGE,
  generateShareToken,
  previewAvailableForFormat,
  shareLinkExpiry,
  validateProjectInput,
  validateShareLinkInput,
  validateVersionInput,
  type VersionGeometrySnapshot,
} from "../types";

const store = new PrismaCadStore(prisma);
const testWorkspaceIds: string[] = [];

async function makeWorkspace(): Promise<string> {
  const ws = await prisma.workspace.create({
    data: {
      name: `test-cad-slice1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ownerUserId: "test-cad-slice1",
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

// Unit square in the z=0 plane: two triangles. Volume = 0, bbox 0..1 x 0..1 x 0.
// 50 bytes per triangle = 12 (normal) + 36 (verts) + 2 (attr).
function binaryStlSquareV2(): Buffer {
  const buf = Buffer.alloc(84 + 2 * 50);
  buf.write("binary STL fixture", 0);
  buf.writeUInt32LE(2, 80);
  const put = (off: number, v: number[]) => {
    buf.writeFloatLE(v[0]!, off);
    buf.writeFloatLE(v[1]!, off + 4);
    buf.writeFloatLE(v[2]!, off + 8);
  };
  const tris = [
    [[0, 0, 0], [1, 0, 0], [1, 1, 0]],
    [[0, 0, 0], [1, 1, 0], [0, 1, 0]],
  ];
  tris.forEach((t, i) => {
    const off = 84 + i * 50;
    put(off + 12, t[0]!);
    put(off + 24, t[1]!);
    put(off + 36, t[2]!);
  });
  return buf;
}

function asciiStlSquare(): Buffer {
  const facet = (a: string, b: string, c: string) =>
    `  facet normal 0 0 1\n    outer loop\n      vertex ${a}\n      vertex ${b}\n      vertex ${c}\n    endloop\n  endfacet\n`;
  return Buffer.from(
    `solid square\n${facet("0 0 0", "1 0 0", "1 1 0")}${facet("0 0 0", "1 1 0", "0 1 0")}endsolid square\n`,
  );
}

function objQuad(): Buffer {
  return Buffer.from(
    "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n",
  );
}

function stepSnippet(): Buffer {
  return Buffer.from(
    "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('drone airframe'),'2;1');\nENDSEC;\nDATA;\n#1=CARTESIAN_POINT('p',(0.,0.,0.));\nENDSEC;\nEND-ISO-10303-21;\n",
  );
}

const SQUARE_SNAPSHOT: VersionGeometrySnapshot = {
  versionId: "v1",
  versionNumber: 1,
  triangleCount: 2,
  bboxMin: [0, 0, 0],
  bboxMax: [1, 1, 0],
  volumeEstimate: 0,
};

const STEP_SNAPSHOT: VersionGeometrySnapshot = {
  versionId: "vstep",
  versionNumber: 2,
  triangleCount: null,
  bboxMin: null,
  bboxMax: null,
  volumeEstimate: null,
};

// ---------- geometry ----------

describe("format sniffing (bytes, never the client declaration)", () => {
  it("sniffs binary STL via the size equation", () => {
    assert.equal(sniffCadFormat(binaryStlSquareV2(), "m.stl").format, "stl");
  });
  it("sniffs ASCII STL", () => {
    assert.equal(sniffCadFormat(asciiStlSquare(), "m.stl").format, "stl");
  });
  it("sniffs OBJ", () => {
    assert.equal(sniffCadFormat(objQuad(), "m.obj").format, "obj");
  });
  it("sniffs STEP by its ISO header", () => {
    const s = sniffCadFormat(stepSnippet(), "airframe.step");
    assert.equal(s.format, "step");
    assert.equal(s.ext, "step");
  });
  it("rejects garbage", () => {
    assert.equal(sniffCadFormat(Buffer.from("not a mesh at all"), "m.stl").format, null);
  });
  it("does not trust a lying extension when bytes are clear", () => {
    assert.equal(sniffCadFormat(objQuad(), "m.stl").format, "obj");
  });
});

describe("mesh stats (computed from real bytes)", () => {
  it("parses binary STL: triangle count, bbox, zero volume", () => {
    const s = parseMeshStats(binaryStlSquareV2(), "stl");
    assert.ok(s);
    assert.equal(s.triangleCount, 2);
    assert.deepEqual(s.bboxMin, [0, 0, 0]);
    assert.deepEqual(s.bboxMax, [1, 1, 0]);
    assert.ok(Math.abs(s.volumeEstimate) < 1e-9);
  });
  it("parses ASCII STL identically", () => {
    const s = parseMeshStats(asciiStlSquare(), "stl");
    assert.ok(s);
    assert.equal(s.triangleCount, 2);
    assert.deepEqual(s.bboxMax, [1, 1, 0]);
  });
  it("parses OBJ, fan-triangulating the quad", () => {
    const s = parseMeshStats(objQuad(), "obj");
    assert.ok(s);
    assert.equal(s.triangleCount, 2);
    assert.deepEqual(s.bboxMax, [1, 1, 0]);
  });
  it("returns null for STEP — no geometry is extracted, ever", () => {
    assert.equal(parseMeshStats(stepSnippet(), "step"), null);
  });
});

// ---------- diff honesty ----------

describe("visual diff metadata", () => {
  it("computes deltas when both sides have real stats", () => {
    const to: VersionGeometrySnapshot = {
      ...SQUARE_SNAPSHOT,
      versionId: "v2",
      versionNumber: 2,
      triangleCount: 6,
      bboxMax: [2, 1, 0],
    };
    const d = computeModelDiff(SQUARE_SNAPSHOT, to);
    assert.equal(d.availability, "computed");
    assert.equal(d.triangleDelta, 4);
    assert.deepEqual(d.sizeDelta, [1, 0, 0]);
    assert.ok(Math.abs((d.centerDelta as number) - 0.5) < 1e-9);
  });
  it("marks unavailable (never a guess) when a side is STEP", () => {
    const d = computeModelDiff(SQUARE_SNAPSHOT, STEP_SNAPSHOT);
    assert.equal(d.availability, "unavailable");
    assert.equal(d.triangleDelta, null);
    assert.equal(d.sizeDelta, null);
    assert.equal(d.centerDelta, null);
    assert.equal(d.volumeDelta, null);
  });
  it("marks unavailable when BOTH sides are unparseable", () => {
    const d = computeModelDiff(STEP_SNAPSHOT, STEP_SNAPSHOT);
    assert.equal(d.availability, "unavailable");
  });
});

// ---------- validation ----------

describe("input validation", () => {
  it("rejects empty project names", async () => {
    assert.equal(await codeOf(Promise.reject(new CadError("x", "y"))), "x");
    try {
      validateProjectInput({ name: "   " });
      assert.fail("should throw");
    } catch (e) {
      assert.equal((e as CadError).code, "INVALID_NAME");
    }
  });
  it("rejects share-link expiry abuse", () => {
    for (const days of [0, -3, 731, 1.5]) {
      try {
        validateShareLinkInput({ expiresInDays: days });
        assert.fail(`should throw for ${days}`);
      } catch (e) {
        assert.equal((e as CadError).code, "INVALID_EXPIRY");
      }
    }
    validateShareLinkInput({}); // defaults are fine
  });
  it("rejects empty/oversized uploads", () => {
    try {
      validateVersionInput({ fileName: "m.stl", fileBytes: Buffer.alloc(0) });
      assert.fail("should throw");
    } catch (e) {
      assert.equal((e as CadError).code, "EMPTY_FILE");
    }
    try {
      validateVersionInput({
        fileName: "m.stl",
        fileBytes: Buffer.alloc(26 * 1024 * 1024),
      });
      assert.fail("should throw");
    } catch (e) {
      assert.equal((e as CadError).code, "TOO_LARGE");
    }
  });
  it("tokens are unique and prefixed", () => {
    const a = generateShareToken();
    const b = generateShareToken();
    assert.ok(a.startsWith(SHARE_LINK_TOKEN_PREFIX));
    assert.notEqual(a, b);
  });
  it("default expiry is 14 days", () => {
    const exp = shareLinkExpiry(null);
    const days = (exp.getTime() - Date.now()) / 86400000;
    assert.ok(days > 13.9 && days < 14.1);
    assert.equal(SHARE_LINK_DEFAULT_EXPIRY_DAYS, 14);
  });
});

// ---------- STEP honesty (the anti-violation core) ----------

describe("STEP honesty (anti-violation)", () => {
  it("STEP never claims a rendered preview", () => {
    assert.equal(previewAvailableForFormat("step"), false);
    assert.equal(previewAvailableForFormat("stl"), true);
    assert.equal(previewAvailableForFormat("obj"), true);
  });
  it("the STEP message says conversion is pending, never claims a render", () => {
    assert.ok(STEP_PREVIEW_MESSAGE.includes("conversion pending"));
    assert.ok(!/rendered|rendering|converted/i.test(STEP_PREVIEW_MESSAGE));
  });
});

// ---------- DB: registry, versions, diffs ----------

describe("project + model registry", () => {
  it("creates a drone-airframe project and lists it tenant-scoped", async () => {
    const ws = await makeWorkspace();
    const p = await store.createProject(ws, "tico@test", {
      name: "Drone airframe",
      description: "Quadcopter airframe revisions",
    });
    assert.equal(p.workspaceId, ws);
    assert.equal(p.name, "Drone airframe");
    const list = await store.listProjects(ws);
    assert.equal(list.length, 1);
    const other = await makeWorkspace();
    assert.deepEqual(await store.listProjects(other), []);
  });

  it("uploading a model records real geometry, size, checksum", async () => {
    const ws = await makeWorkspace();
    const p = await store.createProject(ws, "tico@test", { name: "Drone airframe" });
    const bytes = binaryStlSquareV2();
    const { model, version } = await store.createModelWithVersion(
      ws,
      "tico@test",
      p.id,
      { name: "Frame v1" },
      { fileName: "frame.stl", fileBytes: bytes, notes: "First cut" },
    );
    assert.equal(version.versionNumber, 1);
    assert.equal(version.format, "stl");
    assert.equal(version.triangleCount, 2);
    assert.equal(version.sizeBytes, bytes.length);
    assert.equal(version.checksum.length, 64);
    assert.equal(version.previewAvailable, true);
    assert.equal(version.notes, "First cut");
    assert.deepEqual(version.bboxMax as unknown as number[], [1, 1, 0]);
    assert.equal(model.currentVersionId, version.id);
  });

  it("STEP uploads store + version honestly: nulls, no preview", async () => {
    const ws = await makeWorkspace();
    const p = await store.createProject(ws, "tico@test", { name: "Drone airframe" });
    const { version } = await store.createModelWithVersion(
      ws,
      "tico@test",
      p.id,
      { name: "Frame CAD" },
      { fileName: "airframe.step", fileBytes: stepSnippet() },
    );
    assert.equal(version.format, "step");
    assert.equal(version.previewAvailable, false); // the rule, enforced in the DB
    assert.equal(version.triangleCount, null);
    assert.equal(version.bboxMin, null);
    assert.equal(version.volumeEstimate, null);
  });

  it("rejects unrecognizable files — nothing half-stored", async () => {
    const ws = await makeWorkspace();
    const p = await store.createProject(ws, "tico@test", { name: "Drone airframe" });
    const code = await codeOf(
      store.createModelWithVersion(
        ws,
        "tico@test",
        p.id,
        { name: "Bad" },
        { fileName: "bad.stl", fileBytes: Buffer.from("garbage bytes here") },
      ),
    );
    assert.equal(code, "INVALID_FORMAT");
    assert.equal((await store.listModels(ws, p.id)).length, 0);
  });

  it("version history is immutable: v1 bytes untouched after v2 publish", async () => {
    const ws = await makeWorkspace();
    const p = await store.createProject(ws, "tico@test", { name: "Drone airframe" });
    const { model, version: v1 } = await store.createModelWithVersion(
      ws,
      "tico@test",
      p.id,
      { name: "Frame" },
      { fileName: "frame.stl", fileBytes: binaryStlSquareV2() },
    );
    const v1Before = await prisma.cadModelVersion.findUniqueOrThrow({
      where: { id: v1.id },
    });
    const v2 = await store.addModelVersion(ws, "tico@test", model.id, {
      fileName: "frame.stl",
      fileBytes: asciiStlSquare(),
      notes: "Thickened walls",
    });
    assert.equal(v2.versionNumber, 2);
    assert.equal(v2.supersedesVersionId, v1.id);
    const v1After = await prisma.cadModelVersion.findUniqueOrThrow({
      where: { id: v1.id },
    });
    // Byte-identical: nothing about v1 was rewritten.
    assert.deepEqual(v1After, v1Before);
    const detail = await store.getModelDetail(ws, model.id);
    assert.equal(detail.model.currentVersionId, v2.id);
    assert.deepEqual(
      detail.versions.map((v) => v.versionNumber),
      [2, 1],
    );
  });

  it("records a computed diff between parseable revisions", async () => {
    const ws = await makeWorkspace();
    const p = await store.createProject(ws, "tico@test", { name: "Drone airframe" });
    const { model, version: v1 } = await store.createModelWithVersion(
      ws,
      "tico@test",
      p.id,
      { name: "Frame" },
      { fileName: "frame.stl", fileBytes: binaryStlSquareV2() },
    );
    const v2 = await store.addModelVersion(ws, "tico@test", model.id, {
      fileName: "frame.obj",
      fileBytes: objQuad(),
    });
    const diff = await store.recordDiff(ws, model.id, v1.id, v2.id);
    assert.equal(diff.availability, "computed");
    assert.equal(diff.triangleDelta, 0);
    assert.deepEqual(diff.sizeDelta as unknown as number[], [0, 0, 0]);
    // Idempotent: re-recording overwrites with an identical record.
    const again = await store.recordDiff(ws, model.id, v1.id, v2.id);
    assert.equal(again.id, diff.id);
  });

  it("records an unavailable diff when a side is STEP", async () => {
    const ws = await makeWorkspace();
    const p = await store.createProject(ws, "tico@test", { name: "Drone airframe" });
    const { model, version: v1 } = await store.createModelWithVersion(
      ws,
      "tico@test",
      p.id,
      { name: "Frame" },
      { fileName: "frame.stl", fileBytes: binaryStlSquareV2() },
    );
    const v2 = await store.addModelVersion(ws, "tico@test", model.id, {
      fileName: "frame.step",
      fileBytes: stepSnippet(),
    });
    const diff = await store.recordDiff(ws, model.id, v1.id, v2.id);
    assert.equal(diff.availability, "unavailable");
    assert.equal(diff.triangleDelta, null);
  });

  it("tenant isolation: no cross-workspace reads or writes", async () => {
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    const p = await store.createProject(a, "tico@test", { name: "Drone airframe" });
    const { model } = await store.createModelWithVersion(
      a,
      "tico@test",
      p.id,
      { name: "Frame" },
      { fileName: "frame.stl", fileBytes: binaryStlSquareV2() },
    );
    assert.equal(await codeOf(store.getProject(b, p.id)), "PROJECT_NOT_FOUND");
    assert.equal(await codeOf(store.getModelDetail(b, model.id)), "MODEL_NOT_FOUND");
    assert.equal(await codeOf(store.addModelVersion(b, "x", model.id, {
      fileName: "frame.stl",
      fileBytes: binaryStlSquareV2(),
    })), "MODEL_NOT_FOUND");
    assert.equal(await codeOf(store.createShareLink(b, "x", model.id, {})), "MODEL_NOT_FOUND");
    assert.deepEqual(await store.listModels(b, p.id).catch((e) => (e as CadError).code), "PROJECT_NOT_FOUND");
  });
});

// ---------- DB: share links, fail-closed ----------

describe("share links (fail-closed)", () => {
  async function seeded() {
    const ws = await makeWorkspace();
    const p = await store.createProject(ws, "tico@test", { name: "Drone airframe" });
    const { model, version } = await store.createModelWithVersion(
      ws,
      "tico@test",
      p.id,
      { name: "Frame" },
      { fileName: "frame.stl", fileBytes: binaryStlSquareV2() },
    );
    return { ws, model, version };
  }

  it("creates a prefixed token and resolves to the current version", async () => {
    const { ws, model, version } = await seeded();
    const link = await store.createShareLink(ws, "tico@test", model.id, {
      label: "Review with machine shop",
      expiresInDays: 7,
    });
    assert.ok(link.token.startsWith(SHARE_LINK_TOKEN_PREFIX));
    const resolved = await store.resolveShareToken(link.token);
    assert.equal(resolved.link.id, link.id);
    assert.equal(resolved.version.id, version.id);
    assert.equal(resolved.model.project.name, "Drone airframe");
  });

  it("a pinned link keeps serving the pinned version after a new publish", async () => {
    const { ws, model, version: v1 } = await seeded();
    const link = await store.createShareLink(ws, "tico@test", model.id, {
      pinnedVersionId: v1.id,
    });
    await store.addModelVersion(ws, "tico@test", model.id, {
      fileName: "frame.stl",
      fileBytes: asciiStlSquare(),
    });
    const resolved = await store.resolveShareToken(link.token);
    assert.equal(resolved.version.id, v1.id);
    assert.equal(resolved.version.versionNumber, 1);
  });

  it("an unpinned link follows the current version", async () => {
    const { ws, model } = await seeded();
    const link = await store.createShareLink(ws, "tico@test", model.id, {});
    const v2 = await store.addModelVersion(ws, "tico@test", model.id, {
      fileName: "frame.stl",
      fileBytes: asciiStlSquare(),
    });
    const resolved = await store.resolveShareToken(link.token);
    assert.equal(resolved.version.id, v2.id);
  });

  it("expired links fail closed", async () => {
    const { ws, model } = await seeded();
    const link = await store.createShareLink(ws, "tico@test", model.id, {});
    await prisma.cadShareLink.update({
      where: { id: link.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    assert.equal(await codeOf(store.resolveShareToken(link.token)), "LINK_EXPIRED");
  });

  it("revoked links fail closed (idempotent revoke)", async () => {
    const { ws, model } = await seeded();
    const link = await store.createShareLink(ws, "tico@test", model.id, {});
    const r1 = await store.revokeShareLink(ws, link.id);
    assert.equal(r1.revoked, true);
    const r2 = await store.revokeShareLink(ws, link.id);
    assert.equal(r2.revoked, true);
    assert.equal(await codeOf(store.resolveShareToken(link.token)), "LINK_REVOKED");
  });

  it("unknown tokens fail closed", async () => {
    assert.equal(
      await codeOf(store.resolveShareToken("cadsl_" + "0".repeat(32))),
      "LINK_NOT_FOUND",
    );
    assert.equal(await codeOf(store.resolveShareToken("nope")), "LINK_NOT_FOUND");
  });

  it("one tenant cannot revoke another's link", async () => {
    const { ws, model } = await seeded();
    const other = await makeWorkspace();
    const link = await store.createShareLink(ws, "tico@test", model.id, {});
    assert.equal(await codeOf(store.revokeShareLink(other, link.id)), "LINK_NOT_FOUND");
    // …and the link still resolves.
    const resolved = await store.resolveShareToken(link.token);
    assert.equal(resolved.link.id, link.id);
  });

  it("pinning a foreign version is rejected", async () => {
    const { ws, model } = await seeded();
    const other = await makeWorkspace();
    const p2 = await store.createProject(other, "x", { name: "Other" });
    const { version: foreign } = await store.createModelWithVersion(
      other,
      "x",
      p2.id,
      { name: "Foreign" },
      { fileName: "f.stl", fileBytes: binaryStlSquareV2() },
    );
    assert.equal(
      await codeOf(
        store.createShareLink(ws, "tico@test", model.id, { pinnedVersionId: foreign.id }),
      ),
      "VERSION_NOT_FOUND",
    );
  });
});
