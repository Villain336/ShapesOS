// ShapesOS Phase 11 (seotools): keyword intent heuristic.
// Run: npx tsx --test lib/keywords/__tests__/intent.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferIntent } from "../intent";

describe("inferIntent", () => {
  it("labels transactional modifiers", () => {
    assert.equal(inferIntent("buy running shoes"), "transactional");
    assert.equal(inferIntent("plumber near me"), "transactional");
    assert.equal(inferIntent("Plumbing PRICING"), "transactional");
    assert.equal(inferIntent("hire a react developer"), "transactional");
  });

  it("labels commercial modifiers", () => {
    assert.equal(inferIntent("best crm for startups"), "commercial");
    assert.equal(inferIntent("notion vs obsidian"), "commercial");
    assert.equal(inferIntent("hubspot alternatives"), "commercial");
    assert.equal(inferIntent("standing desk reviews"), "commercial");
  });

  it("labels informational and navigational phrases", () => {
    assert.equal(inferIntent("how to fix a leaky tap"), "informational");
    assert.equal(inferIntent("seo tutorial"), "informational");
    assert.equal(inferIntent("learning python"), "informational");
    assert.equal(inferIntent("acme login"), "navigational");
    assert.equal(inferIntent("acme app"), "navigational");
  });

  it("transactional wins over commercial when both appear", () => {
    assert.equal(inferIntent("best price running shoes"), "transactional");
  });

  it("matches modifiers at word starts only", () => {
    // "order" inside "border", "app" inside "apple", "how" inside "showroom".
    assert.equal(inferIntent("border collie"), "unknown");
    assert.equal(inferIntent("apple pie"), "unknown");
    assert.equal(inferIntent("car showroom"), "unknown");
    assert.equal(inferIntent("eurovision"), "unknown"); // "vs" must be a word
  });

  it("ignores punctuation around modifiers", () => {
    assert.equal(inferIntent("react-vs-vue"), "commercial");
    assert.equal(inferIntent("what's new?"), "informational");
  });

  it("returns unknown for empty / plain phrases", () => {
    assert.equal(inferIntent(""), "unknown");
    assert.equal(inferIntent("running shoes"), "unknown");
  });
});
