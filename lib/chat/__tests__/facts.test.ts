// ShapesOS — Phase 17 (A3, WS=model): the "facts so far" summariser's pure
// parts (inputs, prompt, bounding). The DB round-trip (stored on the thread,
// injected into the next turn) is lib/chat/__tests__/p17-model-db.test.ts.
// Run: env -u DATABASE_URL npx tsx --test lib/chat/__tests__/facts.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { boundFacts, factsInputs, factsPrompt, FACTS_MAX_CALLS, FACTS_MAX_CHARS } from "../facts";
import type { ChatToolCall } from "../tool-exec";

const call = (tool: string, status: ChatToolCall["status"] = "executed", resultSummary = `${tool} result`): ChatToolCall => ({ tool, args: {}, status, resultSummary });

describe("facts summary inputs", () => {
  it("only executed READ tools feed it (no writes, proposals, errors, loop tools)", () => {
    const got = factsInputs([
      call("get_keywords"),
      call("get_rankings", "error"),
      call("create_content_draft"), // spend
      call("ops_send_invoice", "pending_confirmation"),
      call("fetch_more"),
      call("load_skill"),
      call("ops_list_invoices"),
    ]);
    assert.deepEqual(got.map((g) => g.tool), ["get_keywords", "ops_list_invoices"]);
  });

  it("is bounded in calls", () => {
    const many = Array.from({ length: 30 }, () => call("get_alerts"));
    assert.equal(factsInputs(many).length, FACTS_MAX_CALLS);
  });

  it("the prompt carries the prior facts and the new results", () => {
    const p = factsPrompt("- 12 keywords saved", [{ tool: "get_rankings", summary: "4 tracked · visibility 61/100", details: "" }]);
    assert.match(p, /12 keywords saved/);
    assert.match(p, /get_rankings: 4 tracked · visibility 61\/100/);
    assert.match(p, /Output ONLY the updated list/);
  });
});

describe("boundFacts", () => {
  it("keeps bullet lines only, normalised, at most 12 and FACTS_MAX_CHARS", () => {
    assert.equal(boundFacts("Sure! Here you go:\n* a\n• b\n- c\nignore this"), "- a\n- b\n- c");
    assert.equal(boundFacts("no bullets at all"), null);
    const long = Array.from({ length: 40 }, (_, i) => `- fact ${i} ${"x".repeat(200)}`).join("\n");
    const out = boundFacts(long)!;
    assert.ok(out.length <= FACTS_MAX_CHARS);
    assert.ok(out.split("\n").length <= 12);
  });
});
