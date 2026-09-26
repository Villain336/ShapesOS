// Marketr — Phase 10 M2: classifier precision tests.
// Run: npx tsx --test lib/intelligence/radar/__tests__/classifier.test.ts
//
// The docs-edit fixture MUST classify as docs_change; the August 2026 Spam
// Update window MUST classify as rollout. The adversarial fixture (docs
// language that name-drops "spam updates") is the flagship failure mode.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyEvent, classifyEventHeuristicOnly, heuristicClassify } from "../classifier";
import {
  AUG_2026_SPAM_UPDATE_FIXTURE,
  BING_DOCS_FIXTURE,
  BING_ROLLOUT_FIXTURE,
  BING_VOLATILITY_FIXTURE,
  DOCS_EDIT_FIXTURE,
  DOCS_MENTIONS_UPDATE_FAMILY_FIXTURE,
  RANKING_INCIDENT_FIXTURE,
} from "./fixtures";

describe("classifier precision", () => {
  it("docs changelog entry (Sept 24 VideoObject edit) → docs_change", () => {
    const h = heuristicClassify(DOCS_EDIT_FIXTURE);
    assert.equal(h.eventType, "docs_change");
    assert.ok(h.score >= 0.8, `expected high confidence, got ${h.score}`);
  });

  it("August 2026 Spam Update window → rollout", () => {
    const h = heuristicClassify(AUG_2026_SPAM_UPDATE_FIXTURE);
    assert.equal(h.eventType, "rollout");
    assert.ok(h.score >= 0.8, `expected high confidence, got ${h.score}`);
    assert.ok(
      h.reasons.some((r) => /spam/i.test(r)),
      `expected a spam-update reason, got: ${h.reasons.join(" | ")}`,
    );
  });

  it("dashboard ranking incident → rollout at dashboard-prior confidence", () => {
    const h = heuristicClassify(RANKING_INCIDENT_FIXTURE);
    assert.equal(h.eventType, "rollout");
    assert.ok(h.score >= 0.9, `dashboard incidents are confirmed ranking changes, got ${h.score}`);
  });

  it("dashboard incident with no update/rollout/incident language → rollout at weaker confidence", () => {
    const h = heuristicClassify({
      ...RANKING_INCIDENT_FIXTURE,
      title: "Search systems status notice",
      summary: "Service: Ranking. We are posting an informational notice about Search systems.",
    });
    assert.equal(h.eventType, "rollout");
    assert.ok(h.score < 0.9, `unnamed notice should be weaker, got ${h.score}`);
  });

  it("FAILURE MODE: docs language name-dropping 'spam updates' → docs_change", () => {
    const h = heuristicClassify(DOCS_MENTIONS_UPDATE_FAMILY_FIXTURE);
    assert.equal(
      h.eventType,
      "docs_change",
      `adversarial docs fixture misclassified as ${h.eventType}`,
    );
  });

  it("Bing volatility chatter → volatility", () => {
    const h = heuristicClassify(BING_VOLATILITY_FIXTURE);
    assert.equal(h.eventType, "volatility");
  });

  it("Bing confirmed ranking update → rollout", () => {
    const h = heuristicClassify(BING_ROLLOUT_FIXTURE);
    assert.equal(h.eventType, "rollout");
  });

  it("Bing documentation guide → docs_change", () => {
    const h = heuristicClassify(BING_DOCS_FIXTURE);
    assert.equal(h.eventType, "docs_change");
  });

  it("unknown Bing item fails SAFE → docs_change (never alerts)", () => {
    const h = heuristicClassify({
      externalId: "x",
      source: "bing_blog",
      title: "Some misc announcement",
      summary: "Just a note with no signals.",
      startedAt: null,
      endedAt: null,
      url: null,
    });
    assert.equal(h.eventType, "docs_change");
  });
});

describe("classifyEvent (LLM orchestration)", () => {
  it("high-confidence heuristics skip the LLM (llmUsed=false)", async () => {
    const c = await classifyEvent(DOCS_EDIT_FIXTURE);
    assert.equal(c.eventType, "docs_change");
    assert.equal(c.llmUsed, false);
  });

  it("async path agrees with heuristic when LLM is mocked/unavailable", async () => {
    // No LLM keys in test env → provider falls back to mock → heuristic stands.
    const c = await classifyEvent(AUG_2026_SPAM_UPDATE_FIXTURE);
    assert.equal(c.eventType, "rollout");
    assert.equal(c.llmUsed, false);
  });

  it("heuristic-only entry point returns a full verdict", () => {
    const c = classifyEventHeuristicOnly(AUG_2026_SPAM_UPDATE_FIXTURE);
    assert.equal(c.eventType, "rollout");
    assert.ok(c.confidence > 0 && c.confidence <= 1);
    assert.ok(c.reasons.length > 0);
    assert.equal(c.heuristicScore, c.confidence);
  });
});
