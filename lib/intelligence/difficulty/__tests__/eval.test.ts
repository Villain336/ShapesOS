// Marketr — Phase 10 M5: fixture-eval + authority-adapter tests.
// Run: npx tsx --test lib/intelligence/difficulty/__tests__/eval.test.ts
// No network, no API keys, no DB — M7-safe for CI.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runFixtureEval } from "../fixtureEval";
import { parseCcRankLine, fetchOpenPageRank, fetchMoz, lookupCcDomains } from "../authority";
import { MODEL_VERSION } from "../model";

describe("fixture eval (CI-safe, no keys)", () => {
  const report = runFixtureEval();

  it("runs over the synthetic fixtures", () => {
    assert.ok(report.estimates.length >= 5);
    assert.equal(report.modelVersion, MODEL_VERSION);
  });

  it("passes every structural check", () => {
    for (const c of report.checks) {
      assert.equal(c.passed, true, `${c.name}: ${c.detail}`);
    }
    assert.equal(report.passed, true);
  });

  it("orders easy < medium < hard", () => {
    const byKw = new Map(report.estimates.map((e) => [e.keyword, e.estimate]));
    const easy = byKw.get("best ergonomic office chair for short people under $200")!;
    const medium = byKw.get("project management software for small teams")!;
    const hard = byKw.get("insurance")!;
    assert.ok(easy < medium && medium < hard, `easy=${easy} medium=${medium} hard=${hard}`);
  });
});

describe("CC domain-ranks line parser", () => {
  it("parses a ranks line", () => {
    const row = parseCcRankLine("12345\t0.00123\t678\t0.00045\texample.com");
    assert.ok(row);
    assert.equal(row.domain, "example.com");
    assert.equal(row.harmoniccPos, 12345);
    assert.equal(row.prPos, 678);
  });
  it("skips header lines and blanks", () => {
    assert.equal(parseCcRankLine("#harmonicc_pos\t#harmonicc_val\t#pr_pos\t#pr_val\tdomain"), null);
    assert.equal(parseCcRankLine(""), null);
    assert.equal(parseCcRankLine("   "), null);
  });
  it("rejects malformed lines", () => {
    assert.equal(parseCcRankLine("a\tb\tc"), null);
  });
});

describe("authority adapters — graceful without credentials", () => {
  it("Open PageRank returns unavailable (never throws, never calls network) without a key", async () => {
    delete process.env.OPENPAGERANK_API_KEY;
    const r = await fetchOpenPageRank("ws-test", ["example.com"]);
    assert.equal(r.available, false);
    assert.ok(r.reason.includes("OPENPAGERANK_API_KEY"));
    assert.equal(r.signals.size, 0);
  });

  it("Moz returns unavailable without credentials", async () => {
    delete process.env.MOZ_ACCESS_ID;
    delete process.env.MOZ_SECRET_KEY;
    const r = await fetchMoz("ws-test", ["example.com"]);
    assert.equal(r.available, false);
    assert.ok(r.reason.includes("MOZ_ACCESS_ID"));
  });

  it("CC graph returns unavailable when the slice isn't downloaded", async () => {
    process.env.CC_GRAPH_DIR = "/tmp/m5-test-cc-graph-does-not-exist";
    const r = lookupCcDomains(["example.com"]);
    assert.equal(r.available, false);
    assert.ok(r.reason.includes("cc-graph-download.sh"));
    delete process.env.CC_GRAPH_DIR;
  });
});
