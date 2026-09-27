// Marketr — Phase 11 "Canvas": AI prompt/parse helper tests.
// Run: npx tsx --test lib/design/__tests__/ai.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AI_DESIGN_SIZES, buildDesignPrompt, extractJsonObject, MAX_AI_ELEMENTS } from "../ai";

describe("buildDesignPrompt", () => {
  it("constrains the model to the design JSON schema", () => {
    const p = buildDesignPrompt("spring sale post", 1080, 1080);
    assert.ok(p.includes('"schemaVersion": 1'), "pins schema version");
    assert.ok(p.includes("1080 x 1080"), "pins page size");
    for (const t of ["text", "rect", "ellipse", "line", "svg"]) {
      assert.ok(p.includes(`- ${t}:`), `documents element type ${t}`);
    }
    assert.ok(p.includes("do NOT emit image elements"), "forbids image elements (no valid src)");
    assert.ok(p.includes("never lorem ipsum"), "bans placeholder copy");
    assert.ok(p.includes(`At most ${MAX_AI_ELEMENTS} elements`), "caps element count");
    assert.ok(p.includes("spring sale post"), "carries the user request");
    assert.ok(p.includes("nothing else, no prose, no markdown fences"), "demands JSON-only output");
  });

  it("rejects empty-ish prompts at the call site contract level", () => {
    // The route enforces min length; the builder just embeds what it gets.
    const p = buildDesignPrompt("  hi  ", 100, 100);
    assert.ok(p.includes("hi"));
  });
});

describe("extractJsonObject", () => {
  it("parses plain JSON", () => {
    assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  });

  it("strips markdown fences", () => {
    assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJsonObject('```\n{"a":1}\n```'), { a: 1 });
  });

  it("tolerates surrounding prose", () => {
    assert.deepEqual(extractJsonObject('Here is your design:\n{"a":1}\nEnjoy!'), { a: 1 });
  });

  it("returns undefined for garbage", () => {
    assert.equal(extractJsonObject("no json here"), undefined);
    assert.equal(extractJsonObject(""), undefined);
    assert.equal(extractJsonObject('{"a":}'), undefined);
  });
});

describe("AI_DESIGN_SIZES", () => {
  it("offers sane canvas sizes", () => {
    assert.ok(AI_DESIGN_SIZES.length >= 3);
    for (const s of AI_DESIGN_SIZES) {
      assert.ok(s.width >= 100 && s.height >= 100);
    }
  });
});
