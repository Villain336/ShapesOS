// ShapesOS — Phase 7: tool-input validation shared by every chat() adapter (pure).
// Run: npx tsx --test lib/llm/__tests__/tool-input.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkToolUse, invalidToolResult, parseToolInputJson, validateToolInput } from "../tool-input";
import type { ChatJsonSchema, ChatToolDef } from "../types";

const schema: ChatJsonSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    mode: { enum: ["append", "replace"] },
    lines: { type: "array", items: { type: "integer" } },
  },
  required: ["path"],
  additionalProperties: false,
};
const tools: ChatToolDef[] = [{ name: "edit", description: "Edit a file.", inputSchema: schema }];

describe("validateToolInput", () => {
  it("accepts a matching object", () => {
    assert.equal(validateToolInput(schema, { path: "a.ts", mode: "append", lines: [1, 2] }), null);
  });
  it("names the failing fields (types, enums, required, extra keys, arrays)", () => {
    assert.match(validateToolInput(schema, { path: 3 })!, /path/);
    assert.match(validateToolInput(schema, { path: "a", mode: "delete" })!, /mode/);
    assert.match(validateToolInput(schema, {})!, /path/);
    assert.ok(validateToolInput(schema, { path: "a", extra: 1 }));
    assert.match(validateToolInput(schema, { path: "a", lines: [1, "x"] })!, /lines/);
  });
  it("rejects non-objects", () => {
    for (const v of [null, "x", 3, [1]]) assert.match(validateToolInput(schema, v)!, /not a JSON object/);
  });
  it("never echoes the input values", () => {
    const secret = "sk-super-secret-value-123456789";
    assert.ok(!validateToolInput(schema, { path: 1, mode: secret })!.includes(secret));
  });
});

describe("parseToolInputJson (strict)", () => {
  it("empty is an empty object; valid JSON objects parse", () => {
    assert.deepEqual(parseToolInputJson(""), { ok: true, value: {} });
    assert.deepEqual(parseToolInputJson('{"a":1}'), { ok: true, value: { a: 1 } });
  });
  it("refuses what a tolerant parser would repair", () => {
    for (const bad of ['{"a": "say "hi""}', '{"a": tru}', '{"a": 1', "[1,2]", "null"]) {
      assert.equal(parseToolInputJson(bad).ok, false, bad);
    }
  });
});

describe("checkToolUse", () => {
  it("valid input passes through untouched", () => {
    assert.deepEqual(checkToolUse({ id: "t", name: "edit", input: { path: "a" } }, tools, "tool_use"), {
      type: "tool_use",
      id: "t",
      name: "edit",
      input: { path: "a" },
    });
  });
  it("raw JSON wins over the provided (tolerantly parsed) input", () => {
    const r = checkToolUse({ id: "t", name: "edit", input: { path: "a" }, rawJson: '{"path": "a' }, tools, "tool_use");
    assert.match(r.invalid ?? "", /not valid JSON/);
  });
  it("unknown tools and cut-off / refused turns are never runnable", () => {
    assert.match(checkToolUse({ id: "t", name: "nope", input: {} }, tools, "tool_use").invalid ?? "", /unknown tool/);
    assert.match(checkToolUse({ id: "t", name: "edit", input: { path: "a" } }, tools, "max_tokens").invalid ?? "", /output-token cap/);
    assert.match(checkToolUse({ id: "t", name: "edit", input: { path: "a" } }, tools, "refusal").invalid ?? "", /refusal/);
  });
  it("invalidToolResult builds the INVALID_JSON error result with escaping", () => {
    const block = checkToolUse({ id: "t1", name: "edit", input: {}, rawJson: '{"path": "say "hi""}' }, tools, "tool_use");
    const r = invalidToolResult(block, '{"path": "say "hi""}');
    assert.equal(r.toolUseId, "t1");
    assert.equal(r.isError, true);
    const parsed = JSON.parse(r.content as string);
    assert.equal(parsed.INVALID_JSON, '{"path": "say "hi""}');
    assert.match(parsed.reason, /not valid JSON/);
  });
});
