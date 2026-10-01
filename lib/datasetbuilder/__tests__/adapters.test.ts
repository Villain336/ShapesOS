// Marketr — Dataset Builder slice 1 tests: Nango Drive adapter + engines.
// Run: npx tsx --test lib/datasetbuilder/__tests__/adapters.test.ts
//
// No credentials anywhere: the mock Drive adapter is fixture-backed, and the
// live adapters fail closed (NANGO_NOT_CONFIGURED / ENGINE_NOT_CONFIGURED)
// when config is absent — the same fail-closed posture as the wave-2 modules.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MockNangoDriveAdapter,
  NangoCloudDriveAdapter,
  type DriveFileContent,
} from "../nango";
import {
  FrontierExtractionEngine,
  MockExtractionEngine,
  NemoDataDesignerEngine,
} from "../engines";
import { DatasetBuilderError } from "../types";

const enc = new TextEncoder().encode.bind(new TextEncoder());

function fixture(): DriveFileContent {
  return {
    ref: {
      id: "f-1",
      name: "Pricing",
      mimeType: "text/csv",
      sizeBytes: 20,
      modifiedTime: null,
    },
    bytes: enc("plan,price\nBasic,29\n"),
    filename: "pricing.csv",
  };
}

describe("MockNangoDriveAdapter", () => {
  it("lists and downloads fixtures with zero credentials", async () => {
    const adapter = new MockNangoDriveAdapter([fixture()]);
    const files = await adapter.listFiles();
    assert.equal(files.length, 1);
    assert.equal(files[0].id, "f-1");
    const content = await adapter.downloadFile("f-1");
    assert.equal(content.filename, "pricing.csv");
    assert.ok(content.bytes.length > 0);
  });

  it("fails on unknown file ids", async () => {
    const adapter = new MockNangoDriveAdapter([fixture()]);
    await assert.rejects(
      () => adapter.downloadFile("missing"),
      (e) => e instanceof DatasetBuilderError && e.code === "FETCH_FAILED",
    );
  });
});

describe("NangoCloudDriveAdapter", () => {
  it("fails closed without config (negative)", () => {
    assert.throws(
      () => new NangoCloudDriveAdapter(null),
      (e) =>
        e instanceof DatasetBuilderError && e.code === "NANGO_NOT_CONFIGURED",
    );
  });

  it("constructs with config but makes no calls at construction", () => {
    const adapter = new NangoCloudDriveAdapter({
      secretKey: "sk-test",
      connectionId: "conn-test",
    });
    assert.ok(adapter instanceof NangoCloudDriveAdapter);
  });
});

describe("MockExtractionEngine", () => {
  it("extracts grounded entities with lineage, no keys", async () => {
    const engine = new MockExtractionEngine();
    const text = "Acme Corp sells widgets to Dental Offices in Raleigh.";
    const result = await engine.extract(text);
    assert.ok(result.entities.length > 0);
    for (const ent of result.entities) {
      // Every entity is grounded in its source span.
      assert.equal(ent.value, text.slice(ent.charStart, ent.charEnd));
      assert.ok(ent.confidence >= 0 && ent.confidence <= 1);
    }
    assert.equal(result.lineage.engine, "mock");
  });
});

describe("engine stubs", () => {
  it("NeMo Data Designer fails closed without an endpoint (negative)", async () => {
    const engine = new NemoDataDesignerEngine(undefined);
    // Ensure the env var cannot rescue it.
    const prev = process.env.NEMO_DATA_DESIGNER_ENDPOINT;
    delete process.env.NEMO_DATA_DESIGNER_ENDPOINT;
    try {
      await assert.rejects(
        () => engine.extract("some text"),
        (e) =>
          e instanceof DatasetBuilderError && e.code === "ENGINE_NOT_CONFIGURED",
      );
    } finally {
      if (prev !== undefined) process.env.NEMO_DATA_DESIGNER_ENDPOINT = prev;
    }
  });

  it("frontier engine fails closed without a key (negative)", async () => {
    const engine = new FrontierExtractionEngine(undefined);
    const prev = process.env.EXTRACTION_API_KEY;
    delete process.env.EXTRACTION_API_KEY;
    try {
      await assert.rejects(
        () => engine.extract("some text"),
        (e) =>
          e instanceof DatasetBuilderError && e.code === "ENGINE_NOT_CONFIGURED",
      );
    } finally {
      if (prev !== undefined) process.env.EXTRACTION_API_KEY = prev;
    }
  });
});
