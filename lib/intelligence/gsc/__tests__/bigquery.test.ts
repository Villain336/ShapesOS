// Marketr — Phase 10 M1 tests: BigQuery export status degrades gracefully.
// Run: npx tsx --test lib/intelligence/gsc/__tests__/bigquery.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getBigQueryExportStatus, queryBigQueryExport } from "../bigquery";

describe("getBigQueryExportStatus", () => {
  it("never throws and returns configured:false when the export is absent", async () => {
    // Against a workspace with no GSC data source (or no DB), the contract
    // is graceful degradation — never a rejection.
    const status = await getBigQueryExportStatus("ws-does-not-exist");
    assert.equal(status.configured, false);
    assert.ok(typeof status.reason === "string" && status.reason.length > 0);
  });

  it("queryBigQueryExport degrades to a not-configured result", async () => {
    const res = await queryBigQueryExport("ws-does-not-exist", "sc-domain:example.com", {
      start: new Date("2026-09-01"),
      end: new Date("2026-09-02"),
    });
    assert.equal(res.configured, false);
    assert.ok(res.reason.length > 0);
  });
});
