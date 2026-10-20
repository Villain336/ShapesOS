// ShapesOS — Phase 22 (chat): typed tool-result payloads (PURE).
// Run: env -u DATABASE_URL npx tsx --test lib/chat/__tests__/tool-ui.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOOL_PAYLOAD_MAX_CHARS, uiHintFor, uiPayloadFor } from "../tool-ui";

describe("uiHintFor", () => {
  it("prefers the tool's declared hint, then infers from the result shape", () => {
    assert.equal(uiHintFor({ ui: "records" }, { summary: "x", details: "whatever" }), "records");
    assert.equal(uiHintFor(undefined, { summary: "x", details: { rows: [{ a: 1 }] } }), "records");
    assert.equal(uiHintFor(undefined, { summary: "x", details: [{ a: 1 }] }), "records");
    assert.equal(uiHintFor(undefined, { summary: "x", details: { fileId: "f1", url: "/api/files/f1/raw", logicalPath: "/Docs/a.docx" } }), "file");
    assert.equal(uiHintFor(undefined, { summary: "x", details: { fileId: "f1", url: "/api/files/f1/raw", logicalPath: "/Images/a.png" } }), "image");
    assert.equal(uiHintFor(undefined, { summary: "x", details: { diff: "--- a\n+++ b\n" } }), "diff");
    assert.equal(uiHintFor(undefined, { summary: "x", details: { total: 3 } }), "text");
    assert.equal(uiHintFor(undefined, { summary: "x" }), "text");
  });
});

describe("uiPayloadFor", () => {
  it("records: the rows (objects only), their columns and the total", () => {
    const p = uiPayloadFor("records", { summary: "2 rows", details: { rows: [{ keyword: "a", volume: 1 }, { keyword: "b", volume: 2 }], total: 2 } }, "tu1");
    assert.deepEqual(p, { rows: [{ keyword: "a", volume: 1 }, { keyword: "b", volume: 2 }], columns: ["keyword", "volume"], total: 2, truncated: false });
  });

  it("records over the cap keep whole rows up to the cap and say how many there were", () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ id: i, text: "x".repeat(40) }));
    const p = uiPayloadFor("records", { summary: "many", details: { rows } }, "tu2") as { rows: unknown[]; total: number; truncated: boolean; more: { handle: string } };
    assert.ok(p.rows.length < 2000 && p.rows.length > 0);
    assert.ok(JSON.stringify(p).length <= TOOL_PAYLOAD_MAX_CHARS + 200);
    assert.equal(p.total, 2000);
    assert.equal(p.truncated, true);
    assert.deepEqual(p.more, { handle: "tu2" });
  });

  it("file and image: id, url, name and the logical path", () => {
    assert.deepEqual(uiPayloadFor("file", { summary: "s", details: { fileId: "f1", url: "/u", logicalPath: "/Docs/report.docx", bytes: 10 } }, "tu3"), {
      fileId: "f1",
      url: "/u",
      name: "report.docx",
      path: "/Docs/report.docx",
    });
    assert.deepEqual(uiPayloadFor("image", { summary: "s", details: { fileId: "f2", url: "/i", logicalPath: "/Images/hero.png" } }, "tu4"), { fileId: "f2", url: "/i", name: "hero.png", path: "/Images/hero.png" });
  });

  it("text: the details as pretty JSON, capped, with the fetch-more handle when cut", () => {
    const p = uiPayloadFor("text", { summary: "s", details: { note: "hello" } }, "tu5") as { text: string; truncated: boolean };
    assert.equal(p.text, JSON.stringify({ note: "hello" }, null, 2));
    assert.equal(p.truncated, false);
    const big = uiPayloadFor("text", { summary: "s", details: { blob: "y".repeat(TOOL_PAYLOAD_MAX_CHARS * 2) } }, "tu6") as { text: string; truncated: boolean; more: { handle: string } };
    assert.equal(big.text.length, TOOL_PAYLOAD_MAX_CHARS);
    assert.equal(big.truncated, true);
    assert.deepEqual(big.more, { handle: "tu6" });
  });

  it("openui: the program; plan: goal and tasks", () => {
    assert.deepEqual(uiPayloadFor("openui", { summary: "s", details: { program: "root = Text(\"hi\")" } }, "tu7"), { program: 'root = Text("hi")' });
    assert.deepEqual(uiPayloadFor("plan", { summary: "s", details: { goal: "g", tasks: [{ id: "t1", agent: "researcher", brief: "b", deliverable: "d" }], mergeInstructions: "m" } }, "tu8"), {
      goal: "g",
      tasks: [{ id: "t1", agent: "researcher", brief: "b", deliverable: "d" }],
      mergeInstructions: "m",
    });
  });
});
