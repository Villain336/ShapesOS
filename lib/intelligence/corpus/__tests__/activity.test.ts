// Marketr — Knowledge Brain: activity/audit tests.
// Run: npx tsx --test lib/intelligence/corpus/__tests__/activity.test.ts
//
// Uses a temp CORPUS_DIR so real corpus data is untouched. Every assertion
// is about REAL state: the eval results file, the usage counter, proposals.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadEvalSummary,
  recordRetrievalHits,
  readRetrievalUsage,
  buildActivityEvents,
} from "../activity";
import type { CorpusManifest } from "../types";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-audit-"));
  process.env.CORPUS_DIR = dir;
});

afterEach(() => {
  delete process.env.CORPUS_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

function manifest(): CorpusManifest {
  return {
    corpusVersion: 7,
    updatedAt: "2026-09-26T18:16:35.366Z",
    assets: { main: 2523, "by-sa": 155 },
    sources: [],
    evalPrecision: 1,
    evalRunAt: "2026-09-26T18:17:45.450Z",
  };
}

describe("loadEvalSummary", () => {
  it("returns null when the eval never ran", () => {
    assert.equal(loadEvalSummary(), null);
  });

  it("reads the real eval results file and counts per-source top hits", () => {
    fs.writeFileSync(
      path.join(dir, "eval-results.json"),
      JSON.stringify({
        precision: 1,
        questions: 2,
        ranAt: "2026-09-26T18:17:45.450Z",
        results: [
          { correct: true, topSourceId: "apple-hig" },
          { correct: true, topSourceId: "apple-hig" },
        ],
      }),
    );
    const s = loadEvalSummary()!;
    assert.equal(s.precision, 1);
    assert.equal(s.questions, 2);
    assert.equal(s.correct, 2);
    assert.equal(s.hitsBySource.get("apple-hig"), 2);
  });
});

describe("retrieval usage counter", () => {
  it("starts empty — zero hits is the honest default", () => {
    assert.equal(readRetrievalUsage().size, 0);
  });

  it("counts real retrieval hits per source", () => {
    recordRetrievalHits(["a", "b", "a"]);
    const u = readRetrievalUsage();
    assert.equal(u.get("a")!.hits, 2);
    assert.equal(u.get("b")!.hits, 1);
    assert.ok(u.get("a")!.lastHit.length > 0);
  });

  it("never throws, even on corrupt data — the counter recovers", () => {
    fs.writeFileSync(path.join(dir, "retrieval-usage.json"), "not json{");
    assert.doesNotThrow(() => recordRetrievalHits(["a"]));
    assert.equal(readRetrievalUsage().get("a")!.hits, 1);
  });
});

describe("buildActivityEvents", () => {
  it("orders real events newest-first and caps at 50", () => {
    // A real proposal record.
    fs.mkdirSync(path.join(dir, "proposed"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "proposed", "p1.json"),
      JSON.stringify({
        id: "p1",
        title: "Some Course",
        kind: "url",
        url: "https://example.com",
        pillar: "marketing",
        createdAt: "2026-09-26T10:00:00.000Z",
        createdBy: "tester",
        status: "proposed",
      }),
    );
    // A real removal flag.
    fs.writeFileSync(
      path.join(dir, "removals.json"),
      JSON.stringify({ src1: { flaggedAt: "2026-09-25T09:00:00.000Z", flaggedBy: "t", reason: "stale" } }),
    );
    const events = buildActivityEvents(manifest());
    const kinds = events.map((e) => e.type);
    assert.ok(kinds.includes("proposal"));
    assert.ok(kinds.includes("removal-flag"));
    assert.ok(kinds.includes("manifest"));
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i - 1].at >= events[i].at, "newest first");
    }
    assert.ok(events.length <= 50);
  });

  it("works with zero history — only the manifest event", () => {
    const events = buildActivityEvents(manifest());
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "manifest");
    assert.match(events[0].title, /v7/);
  });

  it("accepts a null manifest without events", () => {
    assert.deepEqual(buildActivityEvents(null), []);
  });
});
