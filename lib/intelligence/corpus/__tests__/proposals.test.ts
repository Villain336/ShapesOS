// Marketr — Knowledge Brain: corpus-management storage tests.
// Run: npx tsx --test lib/intelligence/corpus/__tests__/proposals.test.ts
// All file ops run under a temp CORPUS_DIR; the real data/corpus is untouched.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp = "";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brain-corp-"));
  process.env.CORPUS_DIR = tmp;
});

afterEach(() => {
  delete process.env.CORPUS_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function lib() {
  return await import("../proposals");
}

describe("sanitizeId", () => {
  it("accepts clean ids", async () => {
    const { sanitizeId } = await lib();
    assert.equal(sanitizeId("google-search-central"), "google-search-central");
  });
  it("lowercases, strips bad chars, truncates", async () => {
    const { sanitizeId } = await lib();
    assert.equal(sanitizeId("My Cool Source!! 2026"), "my-cool-source-2026");
    assert.ok((sanitizeId("a".repeat(200)) ?? "").length <= 80);
  });
  it("rejects empty", async () => {
    const { sanitizeId } = await lib();
    assert.equal(sanitizeId("!!!"), null);
    assert.equal(sanitizeId(""), null);
  });
});

describe("proposed sources", () => {
  it("round-trips save/get/list/delete", async () => {
    const { saveProposed, getProposed, listProposed, deleteProposed } = await lib();
    const p = {
      id: "test-source",
      title: "Test Source",
      pillar: "growth" as const,
      kind: "url" as const,
      url: "https://example.com",
      status: "proposed" as const,
      createdAt: new Date().toISOString(),
      createdBy: "tester@example.com",
    };
    saveProposed(p);
    assert.deepEqual(getProposed("test-source"), p);
    assert.equal(listProposed().length, 1);
    assert.equal(deleteProposed("test-source"), true);
    assert.equal(getProposed("test-source"), null);
    assert.equal(listProposed().length, 0);
    assert.equal(deleteProposed("missing"), false);
  });

  it("stores payloads separately and removes them on delete", async () => {
    const { saveProposedPayload, readProposedPayload, saveProposed, deleteProposed } = await lib();
    saveProposed({
      id: "p1", title: "P1", pillar: "marketing", kind: "text",
      status: "proposed", createdAt: new Date().toISOString(),
      createdBy: "tester@example.com",
    });
    saveProposedPayload("p1", Buffer.from("hello world"));
    assert.equal(readProposedPayload("p1")?.toString("utf8"), "hello world");
    assert.equal(deleteProposed("p1"), true);
    assert.equal(readProposedPayload("p1"), null);
  });
});

describe("removal flags", () => {
  it("flag/unflag round-trip, non-destructive", async () => {
    const { flagRemoval, unflagRemoval, listRemovals, removalIdMap } = await lib();
    flagRemoval("google-search-central", "outdated", "tester@example.com");
    const flags = listRemovals();
    assert.equal(Object.keys(flags).length, 1);
    assert.equal(flags["google-search-central"].reason, "outdated");
    assert.ok(flags["google-search-central"].flaggedAt);
    assert.equal(flags["google-search-central"].flaggedBy, "tester@example.com");
    assert.equal(removalIdMap().get("google-search-central"), "outdated");
    assert.equal(unflagRemoval("google-search-central"), true);
    assert.equal(Object.keys(listRemovals()).length, 0);
    assert.equal(unflagRemoval("nope"), false);
  });

  it("flags never touch the manifest itself", async () => {
    const { flagRemoval } = await lib();
    flagRemoval("x", "y", "z");
    // The only thing written is removals.json — no manifest, no chunk files.
    assert.deepEqual(fs.readdirSync(tmp).sort(), ["removals.json"]);
  });
});

describe("rebuild job state", () => {
  it("idle by default; write/read round-trip; log tail", async () => {
    const { readRebuildStatus, writeRebuildStatus, readRebuildLogTail, rebuildLogPath } = await lib();
    assert.equal(readRebuildStatus().state, "idle");
    writeRebuildStatus({ state: "running", startedAt: "2026-09-26T00:00:00Z", finishedAt: null, pid: 123, error: null });
    assert.equal(readRebuildStatus().state, "running");
    fs.writeFileSync(rebuildLogPath(), "a\nb\nc\n");
    const tail = readRebuildLogTail(2);
    assert.ok(tail.includes("c"), "tail has last line");
    assert.ok(!tail.includes("a\n"), "tail drops older lines");
  });
});
