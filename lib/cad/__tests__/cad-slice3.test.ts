// Marketr — CAD + Hardware slice 3 tests: prototype pipeline.
// Rate cards, BOM CRUD + rollup math + version pinning, labeled cost
// estimates, quote-request draft flow with the no-live-vendor boundary,
// tenant isolation.
// Run: npx tsx --test lib/cad/__tests__/cad-slice3.test.ts
//
// DB-backed tests run against the local dev DB and clean up their own test
// workspaces (cascades purge CAD rows). Pure-domain tests use real fixtures,
// not mocks.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../../prisma";
import { PrismaCadPipelineStore } from "../pipeline-store";
import {
  buildExportManifest,
  compareCostEstimates,
  computeBomRollup,
  computeCostEstimate,
  DERIVED_METHODS,
  NO_LIVE_VENDOR_API_MESSAGE,
  validateBomLineInput,
  type CostBreakdown,
} from "../prototype";
import { CadError } from "../types";

const store = new PrismaCadPipelineStore(prisma);
const testWorkspaceIds: string[] = [];
const HUMAN = { kind: "human" as const, identity: "tico@test" };
const AGENT = { kind: "agent" as const, identity: "agent-1" };

async function makeWorkspace(): Promise<string> {
  const ws = await prisma.workspace.create({
    data: {
      name: `test-cad-slice3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ownerUserId: "test-cad-slice3",
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
  throw new Error("expected a CadError but the call succeeded");
}

// ---------- Test fixtures: real mesh bytes, not mocks ----------

function binaryStlSquare(): Buffer {
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

function stepSnippet(): Buffer {
  return Buffer.from(
    "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('drone airframe'),'2;1');\nENDSEC;\nDATA;\n#1=CARTESIAN_POINT('p',(0.,0.,0.));\nENDSEC;\nEND-ISO-10303-21;\n",
  );
}

async function makeModel(workspaceId: string, step = false) {
  const project = await store.createProject(workspaceId, "tico@test", { name: "Drone airframe" });
  const bytes = step ? stepSnippet() : binaryStlSquare();
  const { model, version } = await store.createModelWithVersion(
    workspaceId,
    "tico@test",
    project.id,
    { name: "Airframe shell" },
    { fileName: step ? "frame.step" : "frame.stl", fileBytes: bytes },
  );
  return { project, model, version };
}

const CONTACT = {
  name: "Tico Hamphill",
  email: "thamphill02@gmail.com",
  addressLines: ["8750 Haw River Rd", "Kernersville, NC 27284"],
};

// ---------------------------------------------------------------------------
// Pure domain: rollup math
// ---------------------------------------------------------------------------

describe("BOM rollup math (pure)", () => {
  it("sums qty × unit cost per line", () => {
    const rollup = computeBomRollup([
      { id: "a", partName: "Motor", qty: 4, unitName: "pcs", unitCostUsd: 12.5, source: "manual" },
      { id: "b", partName: "Prop", qty: 8, unitName: "pcs", unitCostUsd: 3.25, source: "manual" },
    ]);
    assert.equal(rollup.totalUsd, 76);
    assert.equal(rollup.lines[0]!.lineTotalUsd, 50);
    assert.equal(rollup.lines[1]!.lineTotalUsd, 26);
    assert.equal(rollup.linesMissingCost, 0);
  });

  it("lines without a unit cost contribute $0 and are flagged", () => {
    const rollup = computeBomRollup([
      { id: "a", partName: "Motor", qty: 4, unitName: "pcs", unitCostUsd: 12.5, source: "manual" },
      { id: "b", partName: "Mystery bracket", qty: 2, unitName: "pcs", unitCostUsd: null, source: "manual" },
    ]);
    assert.equal(rollup.totalUsd, 50);
    assert.equal(rollup.linesMissingCost, 1);
    assert.equal(rollup.lines[1]!.missingCost, true);
  });

  it("rejects hand-typed derived: sources — only real derivations create them", async () => {
    assert.deepEqual(DERIVED_METHODS, ["mesh_bodies"]);
    assert.equal(await codeOf(Promise.resolve().then(() => validateBomLineInput({
      partName: "Fasteners",
      qty: 20,
      source: "derived:fastener_count",
    }))), "DERIVED_METHOD_UNSUPPORTED");
  });
});

// ---------------------------------------------------------------------------
// Pure domain: cost estimates
// ---------------------------------------------------------------------------

function baseEstimateInput(overrides: Partial<Parameters<typeof computeCostEstimate>[0]> = {}) {
  const bomRollup = computeBomRollup([
    { id: "a", partName: "Motor", qty: 4, unitName: "pcs", unitCostUsd: 10, source: "manual" },
  ]);
  return {
    bomRollup,
    rates: { setupUsd: 25, perCm3Usd: 2 },
    rateCardId: "rc1",
    rateCardName: "FDM in-house",
    process: "3d_print" as const,
    quantity: 10,
    currency: "USD",
    geometry: { volumeEstimateMm3: 2000 }, // 2 cm³ per unit
    ...overrides,
  };
}

describe("cost estimates are labeled estimates, never quotes (pure)", () => {
  it("3d_print: volume component = perCm3 × cm³ × qty, plus setup", () => {
    const b = computeCostEstimate(baseEstimateInput());
    assert.equal(b.isEstimate, true);
    // bom 40 × 10 = 400; process = 25 + 2×2×10 = 65
    assert.equal(b.bomExtendedUsd, 400);
    assert.equal(b.process.volumeComponentUsd, 40);
    assert.equal(b.process.totalUsd, 65);
    assert.equal(b.grandTotalUsd, 465);
    assert.equal(b.perUnitUsd, 46.5);
    assert.equal(b.rateCard.id, "rc1");
    assert.equal(b.rateCard.name, "FDM in-house");
  });

  it("STEP (no mesh volume): volume component unavailable, never guessed", () => {
    const b = computeCostEstimate(
      baseEstimateInput({ geometry: { volumeEstimateMm3: null } }),
    );
    assert.equal(b.process.volumeComponentUsd, null);
    assert.equal(b.process.volumeCm3, null);
    assert.equal(b.process.totalUsd, 25); // setup only
    assert.ok(b.warnings.some((w) => /no mesh volume/i.test(w)));
  });

  it("missing per-cm³ rate: component unavailable with a warning", () => {
    const b = computeCostEstimate(baseEstimateInput({ rates: { setupUsd: 25 } }));
    assert.equal(b.process.volumeComponentUsd, null);
    assert.ok(b.warnings.some((w) => /per-cm³/i.test(w)));
  });

  it("pcb: per-unit × qty + setup", () => {
    const b = computeCostEstimate(
      baseEstimateInput({
        process: "pcb",
        rates: { setupUsd: 50, perUnitUsd: 12 },
      }),
    );
    assert.equal(b.process.perUnitComponentUsd, 120);
    assert.equal(b.process.totalUsd, 170);
  });

  it("missing unit costs on BOM lines produce a lower-bound warning", () => {
    const bomRollup = computeBomRollup([
      { id: "a", partName: "Bracket", qty: 1, unitName: "pcs", unitCostUsd: null, source: "manual" },
    ]);
    const b = computeCostEstimate({ ...baseEstimateInput(), bomRollup });
    assert.ok(b.warnings.some((w) => /lower bound/i.test(w)));
  });

  it("compare: deltas are pure arithmetic across two estimates", () => {
    const from: { id: string; basis: CostBreakdown } = {
      id: "e1",
      basis: computeCostEstimate(baseEstimateInput()),
    };
    const to: { id: string; basis: CostBreakdown } = {
      id: "e2",
      basis: computeCostEstimate(baseEstimateInput({ rates: { setupUsd: 25, perCm3Usd: 3 } })),
    };
    const d = compareCostEstimates(from, to);
    // volume component 40 → 60
    assert.equal(d.grandTotalDeltaUsd, 20);
    assert.equal(d.processCostDeltaUsd, 20);
    assert.equal(d.bomTotalDeltaUsd, 0);
    assert.equal(d.perUnitDeltaUsd, 2);
  });
});

// ---------------------------------------------------------------------------
// Rate cards
// ---------------------------------------------------------------------------

describe("rate cards", () => {
  it("creates, lists by process, updates, and deletes", async () => {
    const ws = await makeWorkspace();
    const a = await store.createRateCard(ws, "tico@test", {
      name: "FDM in-house",
      process: "3d_print",
      rates: { setupUsd: 25, perCm3Usd: 2 },
      isDefault: true,
    });
    const b = await store.createRateCard(ws, "tico@test", {
      name: "FDM backup",
      process: "3d_print",
      rates: { setupUsd: 30 },
      isDefault: true,
    });
    const all = await store.listRateCards(ws, "3d_print");
    assert.equal(all.length, 2);
    // Only one default per process.
    assert.equal(all.filter((c) => c.isDefault).length, 1);
    assert.equal(all.find((c) => c.isDefault)!.id, b.id);
    void a;

    const updated = await store.updateRateCard(ws, b.id, { name: "FDM backup v2" });
    assert.equal(updated.name, "FDM backup v2");

    await store.deleteRateCard(ws, b.id);
    const rest = await store.listRateCards(ws);
    assert.equal(rest.length, 1);
  });

  it("refuses invalid processes and negative rates", async () => {
    const ws = await makeWorkspace();
    assert.equal(
      await codeOf(store.createRateCard(ws, "tico@test", { name: "X", process: "laser", rates: {} })),
      "INVALID_RATE_CARD",
    );
    assert.equal(
      await codeOf(store.createRateCard(ws, "tico@test", { name: "X", process: "pcb", rates: { setupUsd: -5 } })),
      "INVALID_RATE_CARD",
    );
  });

  it("keeps a source pointer on ingested reference data", async () => {
    const ws = await makeWorkspace();
    const card = await store.createRateCard(ws, "tico@test", {
      name: "Vendor sheet",
      process: "cnc",
      rates: { setupUsd: 120 },
      source: "https://example-vendor.example/rates — accessed 2026-10-02",
    });
    assert.ok(card.source?.includes("example-vendor.example"));
  });

  it("refuses to delete a card cited by an estimate (lineage)", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModel(ws);
    const card = await store.createRateCard(ws, "tico@test", {
      name: "FDM",
      process: "3d_print",
      rates: { setupUsd: 25, perCm3Usd: 2 },
    });
    const bom = await store.createBomVersion(ws, "tico@test", model.id, version.id);
    await store.addBomLine(ws, "tico@test", bom.id, { partName: "Shell", qty: 1, unitCostUsd: 5 });
    await store.createCostEstimate(ws, "tico@test", version.id, {
      bomVersionId: bom.id,
      rateCardId: card.id,
      quantity: 2,
    });
    assert.equal(await codeOf(store.deleteRateCard(ws, card.id)), "RATE_CARD_IN_USE");
  });
});

// ---------------------------------------------------------------------------
// BOM: CRUD, rollup, version pinning
// ---------------------------------------------------------------------------

describe("BOM versions", () => {
  it("creates pinned to one model version; lines roll up", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModel(ws);
    const bom = await store.createBomVersion(ws, "tico@test", model.id, version.id, "v1 parts");
    assert.equal(bom.bomNumber, 1);
    assert.equal(bom.modelVersionId, version.id);

    await store.addBomLine(ws, "tico@test", bom.id, {
      partName: "Brushless motor",
      qty: 4,
      materialSpec: "2207 1960KV",
      supplier: "Vendor A",
      unitCostUsd: 18.5,
    });
    await store.addBomLine(ws, "tico@test", bom.id, {
      partName: "Carbon arm",
      qty: 4,
      unitCostUsd: 6,
    });
    const { rollup } = await store.getBomVersion(ws, bom.id);
    assert.equal(rollup.lineCount, 2);
    assert.equal(rollup.totalUsd, 98);
    assert.ok(rollup.lines.every((l) => l.source === "manual"));
  });

  it("the pin never moves when a new model version publishes", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModel(ws);
    const bom = await store.createBomVersion(ws, "tico@test", model.id, version.id);
    const v2 = await store.addModelVersion(ws, "tico@test", model.id, {
      fileName: "frame-v2.stl",
      fileBytes: binaryStlSquare(),
    });
    assert.notEqual(v2.id, version.id);
    const { bom: refetched } = await store.getBomVersion(ws, bom.id);
    assert.equal(refetched.modelVersionId, version.id); // still v1
    const bom2 = await store.createBomVersion(ws, "tico@test", model.id, v2.id);
    assert.equal(bom2.bomNumber, 2);
    assert.equal(bom2.modelVersionId, v2.id);
  });

  it("edits and deletes lines; source is immutable", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModel(ws);
    const bom = await store.createBomVersion(ws, "tico@test", model.id, version.id);
    const line = await store.addBomLine(ws, "tico@test", bom.id, {
      partName: "Motor",
      qty: 4,
      unitCostUsd: 10,
    });
    const edited = await store.updateBomLine(ws, line.id, { qty: 6 });
    assert.equal(edited.qty, 6);
    assert.equal(
      await codeOf(store.updateBomLine(ws, line.id, { source: "manual" })),
      "BOM_SOURCE_IMMUTABLE",
    );
    await store.deleteBomLine(ws, line.id);
    const { rollup } = await store.getBomVersion(ws, bom.id);
    assert.equal(rollup.lineCount, 0);
    assert.equal(rollup.totalUsd, 0);
  });

  it("rejects bad line input", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModel(ws);
    const bom = await store.createBomVersion(ws, "tico@test", model.id, version.id);
    assert.equal(
      await codeOf(store.addBomLine(ws, "tico@test", bom.id, { partName: "", qty: 1 })),
      "INVALID_BOM_LINE",
    );
    assert.equal(
      await codeOf(store.addBomLine(ws, "tico@test", bom.id, { partName: "X", qty: 0 })),
      "INVALID_BOM_LINE",
    );
    assert.equal(
      await codeOf(store.addBomLine(ws, "tico@test", bom.id, { partName: "X", qty: 1, unitCostUsd: -2 })),
      "INVALID_BOM_LINE",
    );
  });
});

// ---------------------------------------------------------------------------
// Cost estimates (DB)
// ---------------------------------------------------------------------------

describe("cost estimates (persisted, labeled)", () => {
  it("persists a labeled estimate; basis cites the rate card", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModel(ws);
    const card = await store.createRateCard(ws, "tico@test", {
      name: "FDM in-house",
      process: "3d_print",
      rates: { setupUsd: 25, perCm3Usd: 2 },
    });
    const bom = await store.createBomVersion(ws, "tico@test", model.id, version.id);
    await store.addBomLine(ws, "tico@test", bom.id, { partName: "Shell", qty: 1, unitCostUsd: 5 });
    const est = await store.createCostEstimate(ws, "tico@test", version.id, {
      bomVersionId: bom.id,
      rateCardId: card.id,
      quantity: 10,
    });
    const basis = est.basis as unknown as CostBreakdown;
    assert.equal(basis.isEstimate, true);
    assert.equal(basis.rateCard.id, card.id);
    assert.equal(est.grandTotalUsd, basis.grandTotalUsd);
    const listed = await store.listCostEstimates(ws, version.id);
    assert.equal(listed.length, 1);
  });

  it("refuses a BOM pinned to a different version", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModel(ws);
    const v2 = await store.addModelVersion(ws, "tico@test", model.id, {
      fileName: "frame-v2.stl",
      fileBytes: binaryStlSquare(),
    });
    const card = await store.createRateCard(ws, "tico@test", {
      name: "FDM",
      process: "3d_print",
      rates: { setupUsd: 25 },
    });
    const bom = await store.createBomVersion(ws, "tico@test", model.id, version.id);
    assert.equal(
      await codeOf(
        store.createCostEstimate(ws, "tico@test", v2.id, {
          bomVersionId: bom.id,
          rateCardId: card.id,
          quantity: 1,
        }),
      ),
      "BOM_VERSION_MISMATCH",
    );
  });

  it("STEP version: estimate records unavailable volume component, never a guess", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModel(ws, true);
    assert.equal(version.volumeEstimate, null);
    const card = await store.createRateCard(ws, "tico@test", {
      name: "FDM",
      process: "3d_print",
      rates: { setupUsd: 25, perCm3Usd: 2 },
    });
    const bom = await store.createBomVersion(ws, "tico@test", model.id, version.id);
    const est = await store.createCostEstimate(ws, "tico@test", version.id, {
      bomVersionId: bom.id,
      rateCardId: card.id,
      quantity: 5,
    });
    const basis = est.basis as unknown as CostBreakdown;
    assert.equal(basis.process.volumeComponentUsd, null);
    assert.ok(basis.warnings.some((w) => /no mesh volume/i.test(w)));
  });
});

// ---------------------------------------------------------------------------
// Quote requests: draft → confirmed → sent, human-only, no live vendors
// ---------------------------------------------------------------------------

describe("quote-request draft flow", () => {
  it("creates a draft with process options and contact", async () => {
    const ws = await makeWorkspace();
    const { version } = await makeModel(ws);
    const req = await store.createExportRequest(ws, "tico@test", version.id, {
      process: "3d_print",
      quantity: 10,
      processOptions: { material: "PETG", infillPercent: "20" },
      contact: CONTACT,
    });
    assert.equal(req.status, "draft");
    assert.equal(req.process, "3d_print");
    assert.deepEqual(req.processOptions, { material: "PETG", infillPercent: "20" });
    assert.equal((req.contact as unknown as typeof CONTACT).email, CONTACT.email);
  });

  it("rejects bad input", async () => {
    const ws = await makeWorkspace();
    const { version } = await makeModel(ws);
    assert.equal(
      await codeOf(store.createExportRequest(ws, "tico@test", version.id, {
        process: "laser",
        quantity: 1,
        contact: CONTACT,
      })),
      "INVALID_PROCESS",
    );
    assert.equal(
      await codeOf(store.createExportRequest(ws, "tico@test", version.id, {
        process: "pcb",
        quantity: 1.5,
        contact: CONTACT,
      })),
      "INVALID_QUANTITY",
    );
    assert.equal(
      await codeOf(store.createExportRequest(ws, "tico@test", version.id, {
        process: "pcb",
        quantity: 1,
        contact: { name: "T", email: "not-an-email", addressLines: ["x"] },
      })),
      "INVALID_CONTACT",
    );
    assert.equal(
      await codeOf(store.createExportRequest(ws, "tico@test", version.id, {
        process: "3d_print",
        quantity: 1,
        processOptions: { bogus: "x" },
        contact: CONTACT,
      })),
      "INVALID_PROCESS_OPTIONS",
    );
  });

  it("an agent cannot confirm — human-only", async () => {
    const ws = await makeWorkspace();
    const { version } = await makeModel(ws);
    const req = await store.createExportRequest(ws, "tico@test", version.id, {
      process: "cnc",
      quantity: 2,
      contact: CONTACT,
    });
    assert.equal(await codeOf(store.confirmExportRequest(ws, AGENT, req.id)), "AGENT_CANNOT_ACT");
  });

  it("confirm writes the export package; send without confirm is refused", async () => {
    const ws = await makeWorkspace();
    const { model, version } = await makeModel(ws);
    const card = await store.createRateCard(ws, "tico@test", {
      name: "FDM",
      process: "3d_print",
      rates: { setupUsd: 25, perCm3Usd: 2 },
    });
    const bom = await store.createBomVersion(ws, "tico@test", model.id, version.id);
    await store.addBomLine(ws, "tico@test", bom.id, { partName: "Shell", qty: 1, unitCostUsd: 5 });
    await store.createCostEstimate(ws, "tico@test", version.id, {
      bomVersionId: bom.id,
      rateCardId: card.id,
      quantity: 10,
    });
    const req = await store.createExportRequest(ws, "tico@test", version.id, {
      process: "3d_print",
      quantity: 10,
      processOptions: { material: "PETG" },
      contact: CONTACT,
    });

    // ANTI-VIOLATION: nothing is recorded as sent before explicit confirmation.
    assert.equal(
      await codeOf(
        store.sendExportRequest(ws, HUMAN, req.id, {
          recipient: "vendor@example.com",
          sentViaAccount: "tico@gmail",
        }),
      ),
      "QUOTE_NOT_CONFIRMED",
    );

    const confirmed = await store.confirmExportRequest(ws, HUMAN, req.id);
    assert.equal(confirmed.status, "confirmed");
    assert.ok(confirmed.manifestPath?.includes(req.id));
    assert.equal(confirmed.confirmedBy, "tico@test");

    const manifest = await store.getPackageManifest(ws, req.id);
    assert.equal(manifest.package, "cad-export");
    assert.equal(manifest.noLiveVendorApi, true);
    assert.ok(manifest.disclaimer.includes("does not place orders"));
    assert.equal(manifest.version.sha256, version.checksum);
    assert.equal(manifest.bom?.rollup.totalUsd, 5);
    assert.ok(manifest.estimate != null);
  });

  it("double-confirm is refused", async () => {
    const ws = await makeWorkspace();
    const { version } = await makeModel(ws);
    const req = await store.createExportRequest(ws, "tico@test", version.id, {
      process: "pcb",
      quantity: 5,
      contact: CONTACT,
    });
    await store.confirmExportRequest(ws, HUMAN, req.id);
    assert.equal(await codeOf(store.confirmExportRequest(ws, HUMAN, req.id)), "QUOTE_NOT_DRAFT");
  });

  it("send records the tenant's own transmission — account named, no order placed", async () => {
    const ws = await makeWorkspace();
    const { version } = await makeModel(ws);
    const req = await store.createExportRequest(ws, "tico@test", version.id, {
      process: "pcb",
      quantity: 5,
      contact: CONTACT,
    });
    await store.confirmExportRequest(ws, HUMAN, req.id);
    const sent = await store.sendExportRequest(ws, HUMAN, req.id, {
      recipient: "quotes@pcbshop.example",
      sentViaAccount: "tico@company",
    });
    assert.equal(sent.status, "sent");
    assert.equal(sent.recipient, "quotes@pcbshop.example");
    assert.equal(sent.sentViaAccount, "tico@company");
    assert.equal(sent.sentBy, "tico@test");
    assert.ok(sent.sentAt != null);
    // The send is a record, not a transmission: nothing in the store makes
    // network calls (grep the source for fetch/http in review).
  });

  it("an agent cannot record a send", async () => {
    const ws = await makeWorkspace();
    const { version } = await makeModel(ws);
    const req = await store.createExportRequest(ws, "tico@test", version.id, {
      process: "pcb",
      quantity: 5,
      contact: CONTACT,
    });
    await store.confirmExportRequest(ws, HUMAN, req.id);
    assert.equal(
      await codeOf(
        store.sendExportRequest(ws, AGENT, req.id, {
          recipient: "x@y",
          sentViaAccount: "acc",
        }),
      ),
      "AGENT_CANNOT_ACT",
    );
  });

  it("drafts expose no package", async () => {
    const ws = await makeWorkspace();
    const { version } = await makeModel(ws);
    const req = await store.createExportRequest(ws, "tico@test", version.id, {
      process: "cnc",
      quantity: 1,
      contact: CONTACT,
    });
    assert.equal(await codeOf(store.getPackageManifest(ws, req.id)), "QUOTE_NOT_READY");
  });

  it("the no-live-vendor boundary is stated once and referenced everywhere", () => {
    assert.ok(NO_LIVE_VENDOR_API_MESSAGE.includes("does not place orders"));
    const manifest = buildExportManifest({
      request: { id: "r", process: "cnc", quantity: 1, processOptions: {}, contact: CONTACT },
      model: { id: "m", name: "Airframe", projectId: "p" },
      version: {
        id: "v",
        versionNumber: 1,
        format: "stl",
        fileName: "frame.stl",
        sizeBytes: 184,
        checksum: "abc",
        uploadedAt: new Date("2026-10-02T00:00:00Z"),
      },
      bom: null,
      estimate: null,
    });
    assert.equal(manifest.noLiveVendorApi, true);
    assert.equal(manifest.disclaimer, NO_LIVE_VENDOR_API_MESSAGE);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe("tenant isolation", () => {
  it("no cross-tenant reads on any slice-3 path", async () => {
    const ws = await makeWorkspace();
    const other = await makeWorkspace();
    const { model, version } = await makeModel(ws);
    const card = await store.createRateCard(ws, "tico@test", {
      name: "FDM",
      process: "3d_print",
      rates: { setupUsd: 1 },
    });
    const bom = await store.createBomVersion(ws, "tico@test", model.id, version.id);
    const line = await store.addBomLine(ws, "tico@test", bom.id, { partName: "X", qty: 1 });
    const est = await store.createCostEstimate(ws, "tico@test", version.id, {
      bomVersionId: bom.id,
      rateCardId: card.id,
      quantity: 1,
    });
    const req = await store.createExportRequest(ws, "tico@test", version.id, {
      process: "3d_print",
      quantity: 1,
      contact: CONTACT,
    });

    assert.deepEqual(await store.listRateCards(other), []);
    assert.equal(await codeOf(store.getBomVersion(other, bom.id)), "BOM_NOT_FOUND");
    assert.equal(await codeOf(store.addBomLine(other, "x", bom.id, { partName: "Y", qty: 1 })), "BOM_NOT_FOUND");
    assert.equal(await codeOf(store.updateBomLine(other, line.id, { qty: 2 })), "BOM_LINE_NOT_FOUND");
    assert.equal(await codeOf(store.getCostEstimate(other, est.id)), "ESTIMATE_NOT_FOUND");
    assert.equal(await codeOf(store.getExportRequest(other, req.id)), "EXPORT_REQUEST_NOT_FOUND");
    assert.equal(await codeOf(store.confirmExportRequest(other, HUMAN, req.id)), "EXPORT_REQUEST_NOT_FOUND");
    assert.equal(await codeOf(store.listExportRequests(other, model.id)), "MODEL_NOT_FOUND");
  });
});
